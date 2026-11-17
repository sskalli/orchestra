import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { AppServer, command, log, safeError, timeoutMs } from "./app-server.ts";
import type { Event, Id, Thread, Turn } from "./app-server.ts";

type Role = "coordinator" | "lead" | "alpha" | "beta";
type DynamicTool = {
  type: "function";
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string" }>;
    required: string[];
    additionalProperties: false;
  };
};
type Session = { role: Role; threadId: string; active?: Turn; queue: FollowUp[] };
type FollowUp = { prompt: string; resolve: (turn: Turn) => void; reject: (error: unknown) => void };

const model = process.env.CODEX_MODEL;

function tool(name: string, description: string, required: string[]): DynamicTool {
  const properties = Object.fromEntries(required.map((key) => [key, { type: "string" as const }]));
  return { type: "function", name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

const delegationTools = {
  coordinator: tool("start_lead", "Start a lead on a distinct Orchestra conversation with a delegated goal.", ["goal"]),
  lead: tool("start_workers", "Start Alpha and Beta on distinct Orchestra conversations with their delegated goals.", ["alphaGoal", "betaGoal"]),
  beta: tool("hold_for_orchestra", "Pause the current turn until Orchestra releases this test gate. Use only when explicitly asked.", []),
};
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const workerAssignment = {
  alpha: "Reply with ORCHESTRA_ALPHA_DELEGATED to confirm your assigned goal.",
  beta: "Reply with ORCHESTRA_BETA_DELEGATED to confirm your assigned goal.",
};

class Spike {
  private readonly sessions = new Map<Role, Session>();
  private readonly threadRoles = new Map<string, Session>();
  private readonly initialTurns = new Map<Role, Turn>();
  private readonly heldRequests = new Set<Id>();
  private readonly server: AppServer;
  private readonly cwd: string;
  private awaitingApproval = false;
  private awaitingHold = false;

  constructor(server: AppServer, cwd: string) {
    this.server = server;
    this.cwd = cwd;
    server.onEvent = (event) => this.onEvent(event);
    server.onRequest = (request) => this.onRequest(request);
  }

  private async createSession(role: Role): Promise<Session> {
    assert(!this.sessions.has(role), `Duplicate ${role} session`);
    const dynamicTool = role === "alpha" ? undefined : delegationTools[role];
    const result = await this.server.call<{ thread: Thread; model: string; modelProvider: string; approvalsReviewer: string }>(
      "thread/start",
      {
        cwd: this.cwd,
        model,
        modelProvider: "openai",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
        ephemeral: true,
        dynamicTools: dynamicTool ? [dynamicTool] : [],
      },
    );
    assert.equal(result.modelProvider, "openai");
    assert.equal(result.approvalsReviewer, "user");
    assert(!this.threadRoles.has(result.thread.id), "App Server reused a thread ID");
    const session: Session = { role, threadId: result.thread.id, queue: [] };
    this.sessions.set(role, session);
    this.threadRoles.set(session.threadId, session);
    log("thread.started", { role, threadId: session.threadId, model: result.model, provider: result.modelProvider, dynamicTool: dynamicTool?.name });
    return session;
  }

  private session(role: Role) {
    const session = this.sessions.get(role);
    assert(session, `Missing ${role} session`);
    return session;
  }

  private async start(session: Session, prompt: string, purpose: string, parent?: Turn) {
    assert(!session.active, `Cannot start ${purpose} on busy ${session.role}`);
    const { turn } = await this.server.call<{ turn: Turn }>("turn/start", {
      threadId: session.threadId,
      input: input(prompt),
      effort: "low",
      parentTurnId: parent?.id,
      rootTurnId: parent ? parent.rootTurnId ?? parent.id : undefined,
    });
    if (!this.server.matchingEvents((event) => event.method === "turn/completed" && event.params.turn?.id === turn.id).length) {
      assert(!session.active || (session.active as Turn).id === turn.id);
      session.active = turn;
    }
    log("turn.admitted", {
      role: session.role,
      threadId: session.threadId,
      turnId: turn.id,
      parentTurnId: parent?.id,
      rootTurnId: turn.rootTurnId,
      purpose,
    });
    return turn;
  }

  private message(session: Session, prompt: string, purpose: string) {
    if (!session.active) return this.start(session, prompt, purpose);
    return new Promise<Turn>((resolve, reject) => {
      session.queue.push({ prompt, resolve, reject });
      log("message.queued", {
        role: session.role,
        threadId: session.threadId,
        activeTurnId: session.active?.id,
        queueDepth: session.queue.length,
      });
    });
  }

  private onEvent({ method, params }: Event) {
    const session = params.threadId ? this.threadRoles.get(params.threadId) : undefined;
    if (!session) return;
    const turn = params.turn;
    if (method === "turn/started" && turn) session.active = turn;
    if (method === "error") {
      log("provider.error", { role: session.role, threadId: session.threadId, turnId: params.turnId, willRetry: params.willRetry, message: safeError(params.error?.message ?? params.message) });
    }
    if (method !== "turn/completed" || !turn) return;
    log("turn.completed", {
      role: session.role,
      threadId: session.threadId,
      turnId: turn.id,
      status: turn.status,
      error: turn.error ? safeError(turn.error.message) : undefined,
    });
    if (session.active?.id !== turn.id) return;
    delete session.active;
    const next = session.queue.shift();
    if (!next) return;
    if (turn.status === "completed") {
      void this.start(session, next.prompt, "queued follow-up").then(next.resolve, next.reject);
    } else {
      next.reject(new Error(`Queued turn paused after ${turn.status} on ${session.role}`));
    }
  }

  private async onRequest(request: Event & { id: Id }) {
    const { id, method, params } = request;
    const session = params.threadId ? this.threadRoles.get(params.threadId) : undefined;
    if (method === "item/commandExecution/requestApproval" && session?.role === "alpha" &&
      this.awaitingApproval && params.turnId && session.active?.id === params.turnId &&
      (params.kind === undefined || params.kind === "command") && /\bORCHESTRA_APPROVAL\b/.test(params.command ?? "")) {
      this.awaitingApproval = false;
      this.heldRequests.add(id);
      return;
    }
    if (method === "item/tool/call" && params.namespace == null && session) {
      if (session.role === "beta" && params.tool === delegationTools.beta.name &&
        this.awaitingHold && params.turnId && session.active?.id === params.turnId) {
        this.awaitingHold = false;
        this.heldRequests.add(id);
        return;
      }
      if ((session.role === "coordinator" || session.role === "lead") && params.tool === delegationTools[session.role].name) {
        const parent = session.active;
        assert(parent && parent.id === params.turnId, `Delegation arrived outside the active ${session.role} turn`);
        log("delegation.request", { role: session.role, threadId: session.threadId, turnId: parent.id, requestId: id, callId: params.callId, tool: params.tool });
        try {
          const args = params.arguments ?? {};
          const assignments = session.role === "coordinator"
            ? [{ role: "lead" as const, goal: args.goal }]
            : [{ role: "alpha" as const, goal: args.alphaGoal }, { role: "beta" as const, goal: args.betaGoal }];
          for (const assignment of assignments) {
            assert(typeof assignment.goal === "string" && assignment.goal.trim(), `Missing goal for ${assignment.role}`);
          }
          const started = await Promise.all(assignments.map(async ({ role, goal }) => {
            const child = await this.createSession(role);
            const turn = await this.start(child, this.assignmentPrompt(role, String(goal)), "delegated goal", parent);
            this.initialTurns.set(role, turn);
            return { role, threadId: child.threadId, turnId: turn.id };
          }));
          this.toolReply(id, JSON.stringify(started));
        } catch (error) {
          this.toolReply(id, safeError(error), false);
          throw error;
        }
        return;
      }
    }

    log("unexpected.server_request", { method, role: session?.role, threadId: params.threadId, turnId: params.turnId, requestId: id, tool: params.tool, kind: params.kind, hasCommand: typeof params.command === "string" });
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.server.reply(id, { decision: "decline" });
    } else if (method === "item/tool/call") {
      this.toolReply(id, "This tool is unavailable on this Orchestra conversation and turn.", false);
    } else {
      this.server.reject(id, "This request is outside the Orchestra spike scenario.");
    }
  }

  private assignmentPrompt(role: "lead" | "alpha" | "beta", goal: string) {
    if (role === "lead") {
      return `You are the Orchestra team lead. Delegated goal: ${goal}\nYour first action must be to call start_workers once with alphaGoal "${workerAssignment.alpha}" and betaGoal "${workerAssignment.beta}". Use this app tool and no built-in agent delegation. After the tool returns, reply only with ORCHESTRA_LEAD_DELEGATED.`;
    }
    return `You are Orchestra worker ${role}. This is your assigned goal: ${goal}\nDo not use tools. Reply only with ORCHESTRA_${role.toUpperCase()}_DELEGATED.`;
  }

  private toolReply(id: Id, text: string, success = true) {
    this.server.reply(id, { success, contentItems: [{ type: "inputText", text }] });
  }

  private async turnCompletion(session: Session, turn: Turn) {
    const event = await this.server.waitFor(`${session.role} turn completion`, (event) => (
      event.method === "turn/completed" && event.params.threadId === session.threadId && event.params.turn?.id === turn.id
    ));
    assert.equal(event.params.turn?.status, "completed", `${session.role} turn failed: ${safeError(event.params.turn?.error?.message)}`);
  }

  private async completed(session: Session, turn: Turn, expectedReply: string) {
    await this.turnCompletion(session, turn);
    const replies = this.server.matchingEvents((event) => (
      event.method === "item/completed" && event.params.threadId === session.threadId &&
      event.params.turnId === turn.id && event.params.item?.type === "agentMessage"
    ));
    assert(replies.some((reply) => reply.params.item?.text?.trim() === expectedReply), `Missing exact reply ${expectedReply} on ${session.role} turn ${turn.id}`);
    log("reply.verified", { role: session.role, threadId: session.threadId, turnId: turn.id, text: expectedReply });
  }

  private async requestDuring(session: Session, turn: Turn, method: string, toolName?: string) {
    const event = await this.server.waitFor(`${method} on ${session.role}`, (event) => {
      if (event.params.threadId !== session.threadId) return false;
      if (event.method === "turn/completed") return event.params.turn?.id === turn.id;
      return event.method === method && event.params.turnId === turn.id &&
        event.id !== undefined && this.heldRequests.has(event.id) &&
        (toolName === undefined || event.params.tool === toolName);
    });
    assert.equal(event.method, method, `${session.role} turn completed without ${method}: ${safeError(event.params.turn?.error?.message)}`);
    assert(event.id !== undefined, `${method} had no JSON-RPC request ID`);
    this.heldRequests.delete(event.id);
    return { ...event, id: event.id };
  }

  async run() {
    const coordinator = await this.createSession("coordinator");
    const goal = "Prove independent Orchestra worker conversations by delegating a two-worker routing test.";
    const root = await this.start(
      coordinator,
      `You are the Orchestra project coordinator. Your goal: ${goal}\nYour first action must be to call start_lead once with that goal. Use this app tool and no built-in agent delegation. After the tool returns, reply only with ORCHESTRA_COORDINATOR_DELEGATED.`,
      "project goal",
    );
    await this.completed(coordinator, root, "ORCHESTRA_COORDINATOR_DELEGATED");
    const leadTurn = this.initialTurns.get("lead");
    assert(leadTurn, "Coordinator did not start the lead");
    await this.completed(this.session("lead"), leadTurn, "ORCHESTRA_LEAD_DELEGATED");
    assert.equal(this.sessions.size, 4);
    await Promise.all((["alpha", "beta"] as const).map(async (role) => {
      const turn = this.initialTurns.get(role);
      assert(turn, `Lead did not start ${role}`);
      await this.completed(this.session(role), turn, `ORCHESTRA_${role.toUpperCase()}_DELEGATED`);
    }));
    log("check.passed", { check: "delegation" });

    const alpha = this.session("alpha");
    const beta = this.session("beta");
    await Promise.all([alpha, beta].map(async (session) => {
      const marker = `ORCHESTRA_${session.role.toUpperCase()}_DIRECT_${randomUUID().slice(0, 8)}`;
      const turn = await this.message(session, `This is a direct user message for ${session.role}. Reply only with ${marker} and use no tools.`, "direct user message");
      await this.completed(session, turn, marker);
    }));
    log("check.passed", { check: "independent direct worker messages" });

    this.awaitingApproval = true;
    const approval = await this.start(
      alpha,
      "Request approval through the shell tool for the harmless exact command `printf '%s\\n' ORCHESTRA_APPROVAL`. Set sandbox_permissions to require_escalated and include a justification describing this harmless approval-routing test. Call the shell tool once, never retry if declined, then reply only with ORCHESTRA_APPROVAL_FINISHED.",
      "worker approval",
    );
    const request = await this.requestDuring(alpha, approval, "item/commandExecution/requestApproval");
    assert(request.params.itemId, "Worker approval lacked the command item ID");
    log("approval.routed", { role: alpha.role, threadId: alpha.threadId, turnId: approval.id, requestId: request.id, itemId: request.params.itemId });
    this.server.reply(request.id, { decision: "decline" });
    await this.server.waitFor("the worker approval acknowledgement", (event) => (
      event.method === "serverRequest/resolved" && event.params.threadId === alpha.threadId && event.params.requestId === request.id
    ));
    log("approval.resolved", { role: alpha.role, threadId: alpha.threadId, turnId: approval.id, requestId: request.id, decision: "decline" });
    await this.completed(alpha, approval, "ORCHESTRA_APPROVAL_FINISHED");
    log("check.passed", { check: "worker approval routing" });

    this.awaitingHold = true;
    const hold = await this.start(
      beta,
      "First call hold_for_orchestra exactly once. When the tool returns, reply only with ORCHESTRA_BEFORE_STEERING unless the user sends a newer instruction.",
      "worker busy turn",
    );
    const gate = await this.requestDuring(beta, hold, "item/tool/call", delegationTools.beta.name);
    assert.equal(beta.active?.id, hold.id);
    const queued = this.message(beta, "Reply only with ORCHESTRA_QUEUED_FOLLOWUP and use no tools.", "follow-up");
    // The queued promise can reject before the steer or active completion resolves.
    void queued.catch(() => {});
    assert.equal(beta.queue.length, 1);

    let steeringError: unknown;
    try {
      const steer = await this.server.call<{ turnId: string }>("turn/steer", {
        threadId: beta.threadId,
        expectedTurnId: hold.id,
        input: input("This is a steering message for your current turn. After the hold returns, reply only with ORCHESTRA_STEERED. Use no further tools."),
      });
      assert.equal(steer.turnId, hold.id);
      log("steer.admitted", { role: beta.role, threadId: beta.threadId, turnId: steer.turnId });
    } catch (error) {
      steeringError = error;
      log("steer.failed", { role: beta.role, threadId: beta.threadId, turnId: hold.id, message: safeError(error) });
    }

    assert.equal(beta.queue.length, 1, "Follow-up drained while worker was still busy");
    this.toolReply(gate.id, "Orchestra released the hold.");
    await this.turnCompletion(beta, hold);
    const next = await queued;
    assert.notEqual(next.id, hold.id, "Queue submission steered the active turn");
    await this.completed(beta, next, "ORCHESTRA_QUEUED_FOLLOWUP");
    log("check.passed", { check: "busy queue" });
    if (steeringError) throw steeringError;
    await this.completed(beta, hold, "ORCHESTRA_STEERED");
    log("check.passed", { check: "current turn steering" });
  }
}

async function main() {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647, "CODEX_TIMEOUT_MS must be a positive integer within the Node timer range");
  const { stdout } = await promisify(execFile)(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const version = stdout.trim();
  assert(version, "Codex --version returned no version");
  log("runtime.version", { codex: version, node: process.version });

  const cwd = await mkdtemp(join(tmpdir(), "orchestra-spike-"));
  const server = new AppServer(cwd);
  try {
    await server.call("initialize", {
      clientInfo: { name: "orchestra_spike", title: "Orchestra Spike", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.notify("initialized");
    const account = await server.call<{ account: { type: string; planType?: string } | null }>("account/read", { refreshToken: false });
    log("account.checked", { authType: account.account?.type ?? null, planType: account.account?.planType });
    assert.equal(account.account?.type, "chatgpt", "Sign in to Codex with ChatGPT before running the spike");
    await new Spike(server, cwd).run();
    log("spike.passed");
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  log("spike.failed", { message: safeError(error) });
  process.exitCode = 1;
});
