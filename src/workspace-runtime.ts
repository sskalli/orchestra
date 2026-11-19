import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { AppServer, safeError } from "./app-server.ts";
import type { Event, FileUpdate, Id, Thread, Turn } from "./app-server.ts";
import { checkClaudeCode, ClaudeCodeError, runClaudeCode } from "./claude-code.ts";
import { createFeatureWorktree, describeWorktreePatch } from "./workspace-worktree.ts";
import { fingerprintCandidate, integrateCandidates } from "./workspace-integration.ts";
import type { SavedSession, workspaceStore } from "./workspace-store.ts";

export type AgentStatus = "idle" | "working" | "attention" | "awaiting-confirmation" | "done" | "error" | "notice";
export type AgentRole = "coordinator" | "lead" | "worker";
export type SystemMessageKind = "error" | "action" | "warning" | "notice" | "success";
export type WorkspaceMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  kind?: SystemMessageKind;
  sourceAgentId?: string;
  sourceAgentName?: string;
  reportLabel?: string;
  providerItemId?: string;
  state?: "queued" | "streaming" | "failed" | "cancelled";
  approval?: { id: string; state: "pending" | "accepted" | "declined" | "expired"; canAccept?: boolean };
};
export type WorkspaceAgent = {
  id: string;
  name: string;
  role: AgentRole;
  parentId?: string;
  goal?: string;
  duty?: Duty;
  candidate?: Candidate;
  submissionId?: string;
  submissionFingerprint?: string;
  validationTargetId?: string;
  integration?: { id: string; path: string; base: string; fingerprint: string; sources: { agentId: string; submissionId: string; head: string; fingerprint?: string }[]; confirmed?: boolean };
  check?: { submissionId: string; targetAgentId?: string; candidateFingerprint?: string; outcome: "passed" | "changes-requested" | "blocked"; summary: string; recordedAt: number };
  status: AgentStatus;
  messages: WorkspaceMessage[];
  queueDepth: number;
  queuePaused?: boolean;
  unavailableReason?: string;
  canSteer: boolean;
  canCancel?: boolean;
  simulation?: boolean;
  archivedAt?: number;
  lifecycleBusy?: boolean;
  lifecycleBlockedReason?: string;
};
export type WorkspaceProvider = "codex" | "claude";
export type WorkspaceSnapshot = {
  project: { name: string; path: string };
  modelProvider: string;
  provider: { name: WorkspaceProvider; state: "demo" | "connecting" | "ready" | "signed-out" | "error" | "usage-limit"; message?: string };
  agents: WorkspaceAgent[];
};
export type AgentSignal = { id: string; senderId: string; recipientId: string };
export type WorkspaceCommand =
  | { type: "send" | "steer"; agentId: string; text: string }
  | { type: "resumeQueue" | "cancel" | "restore" | "delete"; agentId: string }
  | { type: "archive"; agentId: string; stopRunning?: boolean }
  | { type: "approval"; agentId: string; approvalId: string; decision: "accept" | "decline" };

type Candidate = { path: string; base: string };
type Duty = "coder" | "reviewer" | "tester" | "analyser" | "designer" | "pm";

type Run = {
  turn?: Turn; messageOffset?: number; message: WorkspaceMessage; check?: WorkspaceAgent["check"];
  demoTimer?: ReturnType<typeof setTimeout>; claude?: ReturnType<typeof runClaudeCode>;
  patches?: Map<string, FileUpdate[]>;
  checkTarget?: { agentId: string; submissionId: string; fingerprint: string };
};
type PendingApproval = {
  requestId?: Id; message: WorkspaceMessage; turnId?: string; itemId?: string; patchPreview?: string;
};
type AgentSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  freshThread?: boolean;
  toolVersion?: number;
  waitingFor?: string;
  run?: Run;
  recovery?: SavedSession["run"];
  opening?: boolean;
  queue: WorkspaceMessage[];
  stream: Map<string, WorkspaceMessage>;
  approvals: Map<string, PendingApproval>;
};

const coordinatorId = "coordinator";
const managementToolVersion = 7;
const workspaceThreadConfig = { "features.multi_agent": false, "features.multi_agent_v2": false };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const hasSubmittedMessage = (agent: WorkspaceAgent) =>
  agent.messages.some((entry) => entry.role === "user" && entry.state !== "queued");
const tool = {
  type: "function",
  deferLoading: false,
  name: "delegate_agent",
  description: "Start an addressable team lead, coder, reviewer, tester, analyser, designer, or product adviser. The pilot can start teams or read-only tasks. Leads can start multiple coders in isolated worktrees. Set afterAgentId to attach a check to that coder and wait for its current submission. Coders can delegate reviewer, tester, or designer children for their own candidate.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, goal: { type: "string" },
      duty: { type: "string", enum: ["lead", "coder", "reviewer", "tester", "analyser", "designer", "pm"] },
      afterAgentId: { type: "string" } },
    required: ["name", "goal", "duty"],
    additionalProperties: false,
  },
};
const inspectGitTool = {
  type: "function",
  deferLoading: false,
  name: "inspect_project_git",
  description: "Read current local branches, HEAD, and worktree status. Use this for fresh Git facts when asked to recheck the project.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function inspectGit(cwd: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], {
    cwd, env, encoding: "utf8", timeout: 5000,
  }).trim();
  return {
    path: cwd,
    head: git("rev-parse", "HEAD"),
    branches: git("branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean),
    status: git("status", "--short", "--branch"),
  };
}
const relayTool = {
  type: "function",
  name: "message_agent",
  description: "Send an instruction to an existing descendant in your team. Use the ID from delegation or list_agents.",
  inputSchema: {
    type: "object",
    properties: { agentId: { type: "string" }, goal: { type: "string" } },
    required: ["agentId", "goal"],
    additionalProperties: false,
  },
};
const confirmCoderTool = {
  type: "function",
  name: "confirm_implementation",
  description: "Confirm a direct-report coder's submission after checking required review and test results. This does not merge the candidate.",
  inputSchema: {
    type: "object",
    properties: { agentId: { type: "string" } },
    required: ["agentId"],
    additionalProperties: false,
  },
};
const integrateTool = {
  type: "function", name: "integrate_candidates",
  description: "Combine accepted coder candidates into an isolated integration worktree. Does not merge into the project. Delegate a tester without afterAgentId to validate this exact combined snapshot, then confirm_integration.",
  inputSchema: { type: "object", properties: { agentIds: { type: "array", items: { type: "string" }, minItems: 2 } }, required: ["agentIds"], additionalProperties: false },
};
const confirmIntegrationTool = {
  type: "function", name: "confirm_integration",
  description: "Accept the current combined snapshot only after its independent integration test passes. Does not merge into the project; user approval is still required.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const reportTool = {
  type: "function",
  name: "read_agent_report",
  description: "Read a team member's latest result and verification outcome, even when its chat notification was posted outside this turn.",
  inputSchema: {
    type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"], additionalProperties: false,
  },
};
const checkTool = {
  type: "function",
  name: "submit_check_result",
  description: "Record the result of this review or test. Use passed only when the required scope passed, changes-requested for findings or failures, or blocked when verification could not finish.",
  inputSchema: {
    type: "object",
    properties: { outcome: { type: "string", enum: ["passed", "changes-requested", "blocked"] }, summary: { type: "string" } },
    required: ["outcome", "summary"], additionalProperties: false,
  },
};

function coderIsReady(agent: WorkspaceAgent) {
  return agent.status === "awaiting-confirmation" || agent.status === "done";
}
const listTool = {
  type: "function",
  name: "list_agents",
  description: "List team descendants, their parent IDs, roles, goals, and statuses.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const decisionTool = {
  type: "function",
  name: "raise_product_decision",
  description: "Notify your parent and the pilot of an unresolved product decision. Include the question, options, and what is blocked.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
    additionalProperties: false,
  },
};

function message(role: WorkspaceMessage["role"], text: string, kind?: SystemMessageKind, sourceAgentId?: string): WorkspaceMessage {
  return { id: randomUUID(), role, text, ...(kind ? { kind } : {}), ...(sourceAgentId ? { sourceAgentId } : {}) };
}

function errorText(error: unknown) {
  return safeError(error instanceof Error ? error.message : error);
}

export class WorkspaceRuntime {
  private readonly state: WorkspaceSnapshot;
  private readonly demo: boolean;
  private readonly providerId: string;
  private readonly store?: ReturnType<typeof workspaceStore>;
  private storageFailed = false;
  private storageReady = false;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly threadSessions = new Map<string, AgentSession>();
  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private readonly signalListeners = new Set<(signal: AgentSignal) => void>();
  private server?: AppServer;
  private started = false;
  private closed = false;
  private simulationRunning = false;
  private readonly simulationTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor({ cwd, demo = false, store, provider = "codex", modelProvider = "openai", claudeExecutable }: {
    cwd: string; demo?: boolean; store?: ReturnType<typeof workspaceStore>; provider?: WorkspaceProvider; modelProvider?: string; claudeExecutable?: string;
  }) {
    const path = resolve(cwd);
    this.demo = demo;
    this.providerId = modelProvider;
    this.store = demo ? undefined : store;
    this.claudeExecutable = claudeExecutable;
    this.state = { project: { name: basename(path), path }, modelProvider, provider: { name: provider, state: demo ? "demo" : "connecting" }, agents: [] };
    const coordinator = this.createAgent(coordinatorId, "Coordinator", "coordinator");
    if (!demo && provider === "claude") coordinator.agent.messages.push(message("system",
      "Claude Code is available for chat. Project tools, team delegation, approval requests and steering are unavailable in this mode.", "notice"));
    if (demo) this.seedDemo();
  }

  private readonly claudeExecutable?: string;

  private setProvider(state: WorkspaceSnapshot["provider"]["state"], detail?: string) {
    this.state.provider = { name: this.state.provider.name, state, message: detail };
  }

  snapshot(): WorkspaceSnapshot {
    return structuredClone(this.state);
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeSignals(listener: (signal: AgentSignal) => void) {
    this.signalListeners.add(listener);
    return () => { this.signalListeners.delete(listener); };
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.demo) return;
    let saved: SavedSession[] | undefined;
    try {
      saved = this.store?.load();
      if (saved) this.restore(saved);
      this.storageReady = true;
    } catch (error) {
      this.storageFailed = true;
      this.setProvider("error", errorText(error));
      this.publish();
      return;
    }
    if (this.state.provider.name === "claude") {
      try {
        await checkClaudeCode(this.state.project.path, this.claudeExecutable);
        if (!this.closed) this.setProvider("ready");
      } catch (error) {
        this.setProvider(error instanceof ClaudeCodeError && error.kind === "signed-out" ? "signed-out" : "error", errorText(error));
      }
      this.publish();
      return;
    }
    const server = new AppServer(this.state.project.path, process.env, false);
    this.server = server;
    server.onEvent = (event) => this.onEvent(event);
    server.onRequest = (event) => this.onRequest(event);
    server.onFailure = (error) => {
      const detail = errorText(error);
      this.setProvider("error", detail);
      for (const session of this.sessions.values()) {
        if (session.run) {
          session.recovery = { messageId: session.run.message.id, turnId: session.run.turn?.id };
          this.finish(session, false, detail);
        }
      }
      this.publish();
    };
    try {
      await server.call("initialize", {
        clientInfo: { name: "orchestra_workspace", title: "Orchestra", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      server.notify("initialized");
      if (this.providerId === "openai") {
        const { account } = await server.call<{ account?: { type: string } }>("account/read", { refreshToken: false });
        if (account?.type !== "chatgpt") {
          this.setProvider("signed-out", "Sign in to Codex with ChatGPT, then restart the workspace.");
          this.publish();
          return;
        }
      }
      const coordinator = this.sessions.get(coordinatorId)!;
      if (!coordinator.threadId) await this.attachThread(coordinator);
      for (const entry of saved ?? []) {
        if (entry.agent.archivedAt) continue;
        if (entry.threadId && this.sessions.get(entry.agent.id)?.threadId === entry.threadId) {
          await this.resumeThread(entry);
        } else if (entry.agent.role === "lead" && !this.sessions.get(entry.agent.id)?.threadId) {
          const lead = this.sessions.get(entry.agent.id)!;
          try {
            await this.attachThread(lead);
            delete lead.agent.unavailableReason;
          } catch (error) {
            lead.agent.unavailableReason = errorText(error);
          }
        }
      }
      if (!this.storageFailed && !this.closed) this.setProvider("ready");
    } catch (error) {
      this.setProvider("error", errorText(error));
    }
    this.publish();
  }

  async close() {
    this.persist();
    this.closed = true;
    for (const timer of this.simulationTimers) clearTimeout(timer);
    this.simulationTimers.clear();
    const stopping = [];
    for (const session of this.sessions.values()) {
      clearTimeout(session.run?.demoTimer);
      if (session.run?.claude) {
        session.run.claude.cancel();
        stopping.push(session.run.claude.completion);
      }
    }
    this.listeners.clear();
    this.signalListeners.clear();
    await this.server?.close();
    await Promise.allSettled(stopping);
  }

  async command(command: WorkspaceCommand) {
    if (this.closed) throw new Error("The workspace is closed.");
    const session = this.sessions.get(command.agentId);
    if (!session) throw new Error("This conversation no longer exists.");
    if (command.type === "archive" || command.type === "restore" || command.type === "delete") {
      await this.lifecycle(session, command);
      return;
    }
    if (!this.isActive(session)) throw new Error("Restore this archived conversation before messaging it.");
    if (command.type === "cancel") {
      if (!session.agent.canCancel || !session.run?.claude) throw new Error("There is no active Claude Code turn to stop.");
      session.agent.canCancel = false;
      session.run.claude.cancel();
      this.publish();
      return;
    }
    if (command.type === "send" && session.agent.id === coordinatorId &&
        /^\/simulate\s+team-messages(?:\s|$)/.test(command.text.trim())) {
      if (this.simulationRunning) throw new Error("The message simulation is already running.");
      this.simulateTeamMessages(session);
      return;
    }
    if (session.agent.simulation) throw new Error("This agent belongs to the local message simulation. Start a new simulation from the main chat.");
    if (!this.available || session.agent.unavailableReason) {
      throw new Error(session.agent.unavailableReason ?? this.state.provider.message ?? "The provider is unavailable.");
    }
    if (!this.demo && this.state.provider.name === "codex" && !session.threadId) throw new Error("This Codex conversation is still opening or failed to open.");
    if (command.type === "resumeQueue") {
      if (!session.agent.queuePaused || !session.queue.length || session.run) throw new Error("There is no paused queue to resume.");
      session.agent.queuePaused = false;
      this.drain(session);
      return;
    }
    if (command.type === "approval") {
      this.resolveApproval(session, command.approvalId, command.decision);
      return;
    }
    if (command.type !== "send" && command.type !== "steer") throw new Error("Unknown workspace command.");
    const text = typeof command.text === "string" ? command.text.trim() : "";
    if (!text || text.length > 24_000) throw new Error("Enter a message of 1–24,000 characters.");
    if (command.type === "steer") {
      await this.steer(session, text);
      return;
    }
    this.checkCandidateAccess(session);
    const next = message("user", text);
    session.agent.messages.push(next);
    await this.enqueue(session, next);
  }

  private isActive(session: AgentSession) {
    return this.sessions.get(session.agent.id) === session && !session.agent.archivedAt && !session.agent.lifecycleBusy;
  }

  private subtree(root: AgentSession) {
    const ids = new Set([root.agent.id]);
    let previous = 0;
    while (previous !== ids.size) {
      previous = ids.size;
      for (const entry of this.sessions.values()) {
        if (entry.agent.parentId && ids.has(entry.agent.parentId)) ids.add(entry.agent.id);
      }
    }
    return [...this.sessions.values()].filter((entry) => ids.has(entry.agent.id));
  }

  private async lifecycle(root: AgentSession, command: Extract<WorkspaceCommand, { type: "archive" }> | { type: "restore" | "delete"; agentId: string }) {
    if (root.agent.role === "coordinator") throw new Error("The pilot conversation cannot be archived or deleted.");
    if (this.storageFailed) throw new Error("Resolve the workspace storage failure before changing teams.");
    if (!this.demo && this.state.provider.state === "connecting") throw new Error("Wait for workspace recovery to finish.");
    const affected = this.subtree(root);
    if (command.type === "restore") {
      if (!root.agent.archivedAt) throw new Error("This agent is not archived.");
      let ancestor = root.agent.parentId && this.sessions.get(root.agent.parentId);
      while (ancestor && ancestor.agent.role !== "coordinator") {
        if (!affected.includes(ancestor)) affected.unshift(ancestor);
        ancestor = ancestor.agent.parentId && this.sessions.get(ancestor.agent.parentId);
      }
    }
    if (affected.some((entry) => entry.agent.lifecycleBusy || entry.opening)) throw new Error("Wait for the current lifecycle or conversation-opening operation to finish.");
    if (command.type !== "restore" && affected.some((entry) => entry.recovery || /active (?:writer|turn)|still be running|unresolved|not acknowledged/i.test(entry.agent.unavailableReason ?? ""))) {
      throw new Error("This team has unresolved provider work. Restart and reconcile it before archiving or deleting.");
    }
    const running = affected.filter((entry) => entry.run || entry.agent.status === "working" || (entry.agent.simulation && this.simulationRunning));
    if (command.type === "delete" && (running.length || affected.some((entry) => entry.approvals.size))) {
      throw new Error("Stop and archive this team before deleting running work or unresolved approvals.");
    }
    if (command.type === "archive" && running.length && !command.stopRunning) {
      throw new Error("This team has running work. Choose Stop and archive.");
    }
    for (const entry of affected) { entry.agent.lifecycleBusy = true; delete entry.agent.lifecycleBlockedReason; }
    this.publish();
    try {
      if (command.type === "archive") {
        if (running.some((entry) => entry.agent.simulation)) {
          for (const timer of this.simulationTimers) clearTimeout(timer);
          this.simulationTimers.clear();
          this.simulationRunning = false;
          for (const entry of this.sessions.values()) {
            if (entry.agent.simulation && entry.agent.status === "working") entry.agent.status = "idle";
          }
        }
        const stopped = await Promise.allSettled(running.map(async (entry) => {
          if (!entry.run) {
            if (entry.agent.simulation) return;
            throw new Error("The provider's running state is unresolved. Restart to reconcile before archiving.");
          }
          if (this.demo) {
            clearTimeout(entry.run.demoTimer);
            this.finish(entry, false, "Stopped for archiving.", true);
            return;
          }
          if (entry.run.claude) entry.run.claude.cancel();
          else {
            if (!entry.run.turn || !entry.threadId) throw new Error("The provider has not acknowledged this turn. Wait for reconciliation before archiving.");
            await this.server!.call("turn/interrupt", { threadId: entry.threadId, turnId: entry.run.turn.id });
          }
          const deadline = Date.now() + 10_000;
          while (entry.run && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          if (entry.run || entry.recovery) throw new Error("Stopping could not be confirmed. The team remains visible; restart to reconcile provider work.");
        }));
        const failed = stopped.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (affected.some((entry) => entry.run || entry.recovery || entry.approvals.size)) throw new Error("Unresolved work remains. The team has not been archived.");
        const now = Date.now();
        const archivedIds = new Set(affected.map((entry) => entry.agent.id));
        const dependents = [...this.sessions.values()].filter((entry) =>
          entry.waitingFor && archivedIds.has(entry.waitingFor) && !archivedIds.has(entry.agent.id));
        const previous = [...affected, ...dependents].map((entry) => {
          const { archivedAt, canSteer, canCancel, queuePaused, queueDepth, status, messages } = entry.agent;
          return { entry, agent: { archivedAt, canSteer, canCancel, queuePaused, queueDepth, status },
            messageCount: messages.length, waitingFor: entry.waitingFor,
            queue: entry.queue.map((queued) => ({ queued, state: queued.state })) };
        });
        for (const entry of affected) {
          entry.agent.archivedAt ??= now;
          entry.agent.canSteer = false;
          entry.agent.canCancel = false;
          entry.agent.queuePaused = entry.queue.length > 0;
          if (entry.waitingFor) {
            delete entry.waitingFor;
            for (const queued of entry.queue.splice(0)) queued.state = "cancelled";
            entry.agent.queueDepth = 0;
            entry.agent.queuePaused = false;
          }
        }
        for (const entry of dependents) {
          delete entry.waitingFor;
          for (const queued of entry.queue.splice(0)) queued.state = "cancelled";
          entry.agent.queueDepth = 0;
          entry.agent.status = "error";
          entry.agent.messages.push(message("system", "The prerequisite agent was archived. Request a new assignment after restoring it.", "action"));
        }
        if (!this.persist()) {
          for (const saved of previous) {
            const { entry } = saved;
            Object.assign(entry.agent, saved.agent);
            entry.agent.messages.length = saved.messageCount;
            entry.waitingFor = saved.waitingFor;
            entry.queue = saved.queue.map(({ queued, state }) => {
              queued.state = state;
              return queued;
            });
          }
          throw new Error("Archiving could not be saved. The team remains visible; resolve the storage failure before trying again.");
        }
      } else if (command.type === "delete") {
        const ids = new Set(affected.map((entry) => entry.agent.id));
        const previousAgents = [...this.state.agents];
        const previousSessions = [...this.sessions.entries()];
        const previousThreads = [...this.threadSessions.entries()];
        const metadata = previousSessions.map(([, entry]) => ({ entry, agent: structuredClone(entry.agent),
          queue: [...entry.queue], waitingFor: entry.waitingFor }));
        for (const entry of this.sessions.values()) {
          for (const historical of entry.agent.messages) {
            if (historical.sourceAgentId && ids.has(historical.sourceAgentId)) {
              historical.sourceAgentName ??= this.sessions.get(historical.sourceAgentId)?.agent.name;
            }
          }
          if (entry.waitingFor && ids.has(entry.waitingFor)) {
            delete entry.waitingFor;
            for (const queued of entry.queue.splice(0)) queued.state = "cancelled";
            entry.agent.queueDepth = 0;
            entry.agent.status = "error";
            entry.agent.messages.push(message("system", "The prerequisite agent was deleted. Request a new assignment.", "action"));
          }
        }
        for (const entry of affected) {
          this.sessions.delete(entry.agent.id);
          if (entry.threadId) this.threadSessions.delete(entry.threadId);
        }
        this.state.agents = this.state.agents.filter((entry) => !ids.has(entry.id));
        if (!this.persist()) {
          this.sessions.clear();
          for (const [id, entry] of previousSessions) this.sessions.set(id, entry);
          this.threadSessions.clear();
          for (const [id, entry] of previousThreads) this.threadSessions.set(id, entry);
          this.state.agents = previousAgents;
          for (const previous of metadata) {
            Object.assign(previous.entry.agent, previous.agent);
            previous.entry.queue = previous.queue;
            previous.entry.waitingFor = previous.waitingFor;
          }
          throw new Error("Deletion could not be saved. The conversations were kept; resolve the storage failure before trying again.");
        }
      } else {
        const archiveDates = affected.map((entry) => entry.agent.archivedAt);
        for (const entry of affected) {
          if (!entry.agent.archivedAt) continue;
          delete entry.agent.archivedAt;
          if (!this.demo && this.state.provider.name === "codex" && this.available) {
            if (entry.threadId && !this.threadSessions.has(entry.threadId)) {
              await this.resumeThread({ agent: entry.agent, threadId: entry.threadId, toolVersion: entry.toolVersion });
            } else if (!entry.threadId && !entry.agent.simulation) {
              try { await this.attachThread(entry); delete entry.agent.unavailableReason; }
              catch (error) { entry.agent.unavailableReason = errorText(error); }
            }
          }
        }
        if (!this.persist()) {
          affected.forEach((entry, index) => { entry.agent.archivedAt = archiveDates[index]; });
          throw new Error("Restoring could not be saved. The conversations remain archived; resolve the storage failure before trying again.");
        }
      }
    } catch (error) {
      root.agent.lifecycleBlockedReason = errorText(error);
      throw error;
    } finally {
      for (const entry of affected) delete entry.agent.lifecycleBusy;
      this.publish();
    }
  }

  private async enqueue(session: AgentSession, next: WorkspaceMessage) {
    if (!this.isActive(session)) throw new Error("This agent is archived or being removed.");
    if (session.run || session.approvals.size || session.agent.queuePaused || session.queue.length) {
      next.state = "queued";
      session.queue.push(next);
      this.update(session);
      if (this.demo && session.run) this.scheduleDemo(session, session.run);
      if (!session.run) this.drain(session);
      return;
    }
    await this.begin(session, next);
  }

  private simulateTeamMessages(pilot: AgentSession) {
    this.simulationRunning = true;
    const create = (name: string, role: AgentRole, parent: AgentSession, duty?: Duty) => {
      const worker = this.createAgent(randomUUID(), name, role, parent.agent.id, "Local animation simulation");
      worker.agent.duty = duty;
      worker.agent.simulation = true;
      return worker;
    };
    const lead = create("message simulation", "lead", pilot);
    const researcher = create("solution analysis", "worker", lead, "analyser");
    const pm = create("UX study", "worker", lead, "pm");
    const uxResearcher = create("design report", "worker", pm, "analyser");
    const designer = create("UX roadmap", "worker", pm, "designer");
    const deliver = (sender: AgentSession, recipient: AgentSession, text: string, done = false) => {
      if (!this.isActive(sender) || !this.isActive(recipient)) return;
      recipient.agent.messages.push(message("system", text, done ? "success" : "notice", sender.agent.id));
      recipient.agent.status = done ? "done" : "working";
      this.signal(sender.agent.id, recipient.agent.id);
      this.publish();
    };
    const later = (action: () => void) => {
      const timer = setTimeout(() => {
        this.simulationTimers.delete(timer);
        if (!this.closed && this.isActive(lead)) action();
      }, 1000 + Math.floor(Math.random() * 4001));
      this.simulationTimers.add(timer);
    };
    pilot.agent.messages.push(message("system", "Local message simulation started: designer failure scenario. The designer will fail, and the lead will ask whether to retry or skip. All reports are dummy responses.", "notice"));
    deliver(pilot, lead, "Simulation: create solution research and a UX study.");
    later(() => {
      deliver(lead, researcher, "Simulation: analyse similar solutions, then say hello.");
      deliver(lead, pm, "Simulation: run a UX study.");
      later(() => {
        researcher.agent.status = "done";
        deliver(researcher, lead, "Dummy solution report. Hello, team lead!");
        later(() => deliver(lead, pilot, "Simulation: the researcher said hello."));
      });
      later(() => {
        deliver(pm, uxResearcher, "Simulation: prepare a project design rundown.");
        later(() => {
          uxResearcher.agent.status = "done";
          deliver(uxResearcher, pm, "Dummy design rundown: clear navigation and concise forms.");
          later(() => {
            deliver(pm, designer, "Simulation: use the dummy research report to propose a roadmap.");
            later(() => {
              const failure = "Simulated designer failure: the roadmap could not be generated.";
              designer.agent.status = "error";
              designer.agent.messages.push(message("system", failure, "error", designer.agent.id));
              deliver(designer, pm, failure);
              pm.agent.status = "error";
              pm.agent.messages.at(-1)!.kind = "error";
              this.publish();
              later(() => {
                deliver(pm, lead, "The designer encountered a simulated failure. The UX roadmap is blocked.");
                lead.agent.status = "error";
                lead.agent.messages.at(-1)!.kind = "error";
                this.publish();
                later(() => {
                  deliver(lead, pilot, "The designer failed in this simulation. Should I retry the roadmap or skip it?", true);
                  pilot.agent.messages.at(-1)!.kind = "action";
                  lead.agent.messages.push(message("system", "Input needed: retry the designer or skip the roadmap?", "action", lead.agent.id));
                  this.simulationRunning = false;
                  this.publish();
                });
              });
            });
          });
        });
      });
    });
  }

  private get available() {
    return this.state.provider.state === "ready" || this.state.provider.state === "demo";
  }

  private persist() {
    if (!this.store || !this.storageReady || this.storageFailed) return !this.storageFailed;
    try {
      this.store.save([...this.sessions.values()].map(({ agent, threadId, freshThread, run, recovery, waitingFor, toolVersion }) => ({
        waitingFor,
        toolVersion,
        agent,
        threadId: agent.archivedAt || run || recovery || (!freshThread && hasSubmittedMessage(agent)) ? threadId : undefined,
        run: run ? { messageId: run.message.id, turnId: run.turn?.id } : recovery,
      })));
      return true;
    } catch (error) {
      this.storageFailed = true;
      this.setProvider("error", `Workspace changes could not be saved. ${errorText(error)}`);
      return false;
    }
  }

  private publish(save = true) {
    if (save && !this.closed) this.persist();
    if (this.closed || !this.listeners.size) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { this.listeners.delete(listener); }
    }
  }

  private signal(senderId: string, recipientId: string) {
    if (this.closed || senderId === recipientId) return;
    const signal = { id: randomUUID(), senderId, recipientId };
    for (const listener of this.signalListeners) {
      try { listener(signal); } catch { this.signalListeners.delete(listener); }
    }
  }

  private update(session: AgentSession) {
    session.agent.queueDepth = session.queue.length;
    session.agent.canSteer = this.available && Boolean(session.run?.turn || (this.demo && session.run)) && !session.approvals.size;
    if (session.approvals.size) session.agent.status = "attention";
    else if (session.run) session.agent.status = "working";
    this.publish();
  }

  private createAgent(id: string, name: string, role: AgentRole, parentId?: string, goal?: string) {
    const agent: WorkspaceAgent = { id, name, role, parentId, goal, status: "idle", messages: [], queueDepth: 0, canSteer: false };
    const session: AgentSession = { agent, queue: [], stream: new Map(), approvals: new Map() };
    this.state.agents.push(agent);
    this.sessions.set(id, session);
    return session;
  }

  private restore(saved: SavedSession[]) {
    this.sessions.clear();
    this.state.agents.length = 0;
    for (const { agent, threadId, run, waitingFor } of saved) {
      const session = this.createAgent(agent.id, agent.name, agent.role, agent.parentId, agent.goal);
      Object.assign(session.agent, agent, { canSteer: false, canCancel: undefined, lifecycleBusy: undefined });
      if ((session.agent.duty === "reviewer" || session.agent.duty === "tester") && session.agent.status === "done" && session.agent.check?.outcome !== "passed") {
        session.agent.status = session.agent.check?.outcome === "changes-requested" ? "error" : "attention";
      }
      if (session.agent.duty === "coder" && session.agent.status === "done" && !session.agent.submissionId) {
        session.agent.status = "awaiting-confirmation";
        session.agent.messages.push(message("system", "This earlier confirmation did not record review and test results. Ask the lead to recheck the submission.", "action"));
      }
      if (session.agent.duty === "coder" && session.agent.status === "awaiting-confirmation" && !session.agent.submissionId) {
        session.agent.submissionId = randomUUID();
      }
      session.threadId = agent.archivedAt || run || hasSubmittedMessage(agent) ? threadId : undefined;
      session.recovery = this.state.provider.name === "codex" ? run : undefined;
      session.queue = agent.messages.filter((entry) => entry.state === "queued");
      agent.messages.forEach((entry) => {
        if (entry.state === "streaming" || entry.id === run?.messageId) entry.state = "failed";
        if (entry.approval?.state === "pending") entry.approval.state = "expired";
      });
      session.agent.queueDepth = session.queue.length;
      session.agent.queuePaused = session.queue.length > 0;
      if (agent.status === "working" || agent.status === "attention") {
        session.agent.status = "error";
        session.agent.messages.push(message("system", "Orchestra restarted during this turn. Check the conversation before sending it again.", "action"));
      }
      if (waitingFor) {
        session.queue.splice(0);
        session.agent.queueDepth = 0;
        session.agent.queuePaused = false;
        for (const entry of session.agent.messages) if (entry.state === "queued") entry.state = "failed";
        session.agent.status = "error";
        session.agent.messages.push(message("system", "This scheduled delegation was interrupted by restart. Ask its parent to schedule it again.", "action"));
      }
      if (!session.threadId && agent.id !== coordinatorId) {
        session.agent.unavailableReason = "This conversation did not finish opening before Orchestra restarted.";
      }
    }
  }

  private async resumeThread({ agent, threadId, run, toolVersion }: SavedSession) {
    const session = this.sessions.get(agent.id)!;
    type RecoveredTurn = Turn & { items?: { id: string; type: string; text?: string }[] };
    try {
      const { thread, modelProvider, initialTurnsPage } = await this.server!.call<{
        thread: Thread & { status?: { type: string }; turns?: RecoveredTurn[] };
        modelProvider: string;
        initialTurnsPage?: { data: RecoveredTurn[] };
      }>("thread/resume", {
        threadId, cwd: this.sessionCwd(session), modelProvider: this.providerId,
        model: process.env.CODEX_MODEL,
        ...this.threadPermissions(session),
        config: workspaceThreadConfig,
        developerInstructions: this.instructions(session),
        excludeTurns: true,
        initialTurnsPage: { limit: 8, itemsView: "full" },
      });
      if (thread.id !== threadId || modelProvider !== this.providerId || this.threadSessions.has(thread.id)) {
        throw new Error("Codex returned an unexpected saved thread.");
      }
      const turn = run?.turnId && (initialTurnsPage?.data ?? thread.turns)?.find((entry) => entry.id === run.turnId);
      const refreshTools = (session.agent.role !== "worker" || session.agent.duty === "coder" || session.agent.duty === "reviewer" ||
        session.agent.duty === "tester") && toolVersion !== managementToolVersion;
      if (thread.status?.type === "active" || turn && turn.status === "inProgress") {
        throw new Error("Codex still reports an active turn. Check again after restarting the workspace.");
      }
      delete session.agent.unavailableReason;
      delete session.recovery;
      this.threadSessions.set(thread.id, session);
      session.toolVersion = toolVersion;
      if (turn && turn.status === "completed") {
        session.agent.status = session.agent.duty === "coder" ? "awaiting-confirmation" : "done";
        const submitted = session.agent.messages.find((entry) => entry.id === run?.messageId);
        if (submitted) delete submitted.state;
        for (const item of turn.items ?? []) {
          if (item.type !== "agentMessage" || typeof item.text !== "string") continue;
          const existing = session.agent.messages.find((entry) => entry.providerItemId === item.id);
          if (existing) {
            existing.text = item.text;
            delete existing.state;
          } else {
            session.agent.messages.push({ ...message("assistant", item.text), providerItemId: item.id });
          }
        }
        session.agent.messages.push(message("system", "Codex confirmed that the interrupted turn completed.", "success"));
      }
      if (refreshTools) {
        await this.attachThread(session);
        this.threadSessions.delete(thread.id);
        session.agent.messages.push(message("system", "Orchestra opened a new Codex session with the current team tools. The previous transcript is still visible here.", "notice"));
      }
    } catch (error) {
      const detail = errorText(error);
      const missingHistory = /^RPC -32600: no rollout found for thread id\b/.test(detail);
      const coordinatorWriterConflict = session.agent.role === "coordinator" &&
        /^RPC -32600: thread \S+ already has an active writer$/.test(detail);
      if (session.agent.role !== "worker" && (missingHistory || coordinatorWriterConflict)) {
        try {
          await this.attachThread(session);
          delete session.recovery;
          delete session.agent.unavailableReason;
          session.agent.status = "idle";
          session.agent.messages.push(message("system", coordinatorWriterConflict
            ? "Codex could not reopen the main chat because the previous thread has an active writer. Orchestra opened a replacement chat and kept the transcript. The previous thread may still be active. No interrupted request was resubmitted."
            : "Codex had no saved history for this session. Orchestra reopened it with the current tools and kept the visible transcript.", "warning"));
          return;
        } catch (replacementError) {
          session.agent.unavailableReason = errorText(replacementError);
        }
      } else {
        session.agent.unavailableReason = detail;
      }
      session.agent.status = "error";
      session.agent.messages.push(message("system", `Unable to resume this Codex conversation. ${session.agent.unavailableReason}`, "error"));
    }
  }

  private sessionCwd(session: AgentSession) {
    return session.agent.candidate?.path ?? this.state.project.path;
  }

  private threadPermissions(session: AgentSession) {
    return {
      sandbox: session.agent.duty === "coder" ? "workspace-write" : "read-only",
      approvalPolicy: this.fileApprovalPolicy(session),
      approvalsReviewer: "user",
      runtimeWorkspaceRoots: [this.sessionCwd(session)],
    };
  }

  private fileApprovalPolicy(session: AgentSession) {
    return session.agent.duty === "coder" && session.agent.candidate ? "on-request" : "never";
  }

  private instructions(session: AgentSession) {
    const role = session.agent.role === "worker" ? session.agent.duty ?? "analyser" : session.agent.role;
    const instructions = readFileSync(new URL(`../roles/${role}.md`, import.meta.url), "utf8");
    return "Follow the project's AGENTS.md for coding conventions, commands, and local workflow. " +
      "Use Orchestra's tools for delegation and product questions.\n\n" + instructions;
  }

  private async attachThread(session: AgentSession) {
    session.opening = true;
    try {
    const { thread, modelProvider } = await this.server!.call<{ thread: Thread; modelProvider: string }>("thread/start", {
      cwd: this.sessionCwd(session),
      model: process.env.CODEX_MODEL,
      modelProvider: this.providerId,
      ...this.threadPermissions(session),
      config: workspaceThreadConfig,
      ephemeral: false,
      ...(session.agent.role !== "worker" && { environments: [] }),
      dynamicTools: session.agent.role === "worker" && session.agent.duty !== "coder"
        ? [decisionTool, ...(session.agent.duty === "reviewer" || session.agent.duty === "tester" ? [checkTool] : [])]
        : [tool, relayTool, listTool, inspectGitTool, reportTool, decisionTool,
          ...(session.agent.role === "lead" ? [confirmCoderTool, integrateTool, confirmIntegrationTool] : [])],
      developerInstructions: this.instructions(session),
    });
    if (modelProvider !== this.providerId || this.threadSessions.has(thread.id)) throw new Error("Codex returned an unexpected thread.");
    session.threadId = thread.id;
    session.freshThread = true;
    session.toolVersion = managementToolVersion;
    this.threadSessions.set(thread.id, session);
    this.publish();
    } finally { session.opening = false; }
  }

  private teamReportContext(session: AgentSession) {
    if (session.agent.role === "worker" && session.agent.duty !== "coder") return undefined;
    const team = this.subtree(session).filter((entry) => entry !== session && this.isActive(entry));
    const reports = team.map(({ agent }) => {
      const recent = agent.messages.findLast((entry) => entry.role === "assistant" && !entry.state);
      return {
        agentId: agent.id, parentId: agent.parentId, name: agent.name, duty: agent.duty,
        status: agent.status, submissionId: agent.submissionId,
        check: agent.check && { ...agent.check, summary: agent.check.summary.slice(0, 2400) },
        latestReply: recent?.text.slice(0, 2400),
      };
    });
    return {
      ...(session.freshThread && {
        orchestra_previous_chat: {
          kind: "untrusted",
          name: "orchestra_previous_chat",
          value: JSON.stringify(session.agent.messages.slice(-12).map(({ role, text, state }) => ({
            role, text: text.slice(0, 2000), state,
          }))),
        },
      }),
      orchestra_team_reports: {
        kind: "untrusted",
        name: "orchestra_worker_reports",
        value: JSON.stringify(reports),
      },
    };
  }

  private async begin(session: AgentSession, next: WorkspaceMessage, parent?: Turn) {
    if (!this.isActive(session)) return;
    const run: Run = { message: next, messageOffset: session.agent.messages.length };
    try {
      this.checkCandidateAccess(session);
      if (session.agent.duty === "reviewer" || session.agent.duty === "tester") run.checkTarget = this.captureCheckTarget(session);
    } catch (error) {
      next.state = "failed";
      delete session.agent.check;
      session.agent.status = "error";
      session.agent.queuePaused = session.queue.length > 0;
      session.agent.messages.push(message("system", `The turn could not start: ${errorText(error)}`, "action"));
      this.update(session);
      this.reportDelegation(session, false);
      return;
    }
    if (session.agent.duty === "coder") {
      session.agent.submissionId = randomUUID();
      delete session.agent.submissionFingerprint;
      for (const lead of this.sessions.values()) {
        if (lead.agent.integration?.sources.some((source) => source.agentId === session.agent.id)) delete lead.agent.integration.confirmed;
      }
    }
    if (session.agent.duty === "reviewer" || session.agent.duty === "tester") delete session.agent.check;
    session.run = run;
    delete next.state;
    this.update(session);
    if (this.storageFailed) {
      this.finish(session, false, "The turn was paused because Orchestra could not save it.");
      return;
    }
    if (this.demo) {
      this.scheduleDemo(session, run);
      return;
    }
    if (this.state.provider.name === "claude") {
      void this.beginClaude(session, run);
      return;
    }
    try {
      const { turn } = await this.server!.call<{ turn: Turn }>("turn/start", {
        threadId: session.threadId,
        approvalPolicy: this.fileApprovalPolicy(session),
        ...(session.agent.role !== "worker" && { environments: [] }),
        ...(session.agent.candidate && {
          cwd: this.sessionCwd(session),
          runtimeWorkspaceRoots: [this.sessionCwd(session)],
          sandboxPolicy: session.agent.duty === "coder"
            ? { type: "workspaceWrite", writableRoots: [this.sessionCwd(session)], networkAccess: false,
                excludeTmpdirEnvVar: true, excludeSlashTmp: true }
            : { type: "readOnly", networkAccess: false },
        }),
        input: input(next.text),
        additionalContext: this.teamReportContext(session),
        effort: "low",
        parentTurnId: parent?.id,
        rootTurnId: parent ? parent.rootTurnId ?? parent.id : undefined,
      });
      session.freshThread = false;
      if (session.run === run) {
        run.turn ??= turn;
        this.update(session);
      }
    } catch (error) {
      if (session.run === run) {
        if (errorText(error) === "Timed out calling turn/start") {
          session.agent.queuePaused = true;
          session.agent.messages.push(message("system", "Codex did not acknowledge this turn in time. It may still be running. Queued messages are paused; wait for a provider update or restart to reconcile before retrying.", "warning"));
          this.update(session);
          return;
        }
        this.finish(session, false, errorText(error));
        this.reportDelegation(session, false);
      }
    }
  }

  private async beginClaude(session: AgentSession, run: Run) {
    const sessionId = session.threadId ?? randomUUID();
    try {
      run.claude = runClaudeCode({
        cwd: this.state.project.path,
        prompt: run.message.text,
        sessionId,
        resume: Boolean(session.threadId),
        executable: this.claudeExecutable,
        onText: (text) => {
          if (this.closed || session.run !== run || !session.agent.canCancel) return;
          let entry = session.stream.get(sessionId);
          if (!entry) {
            entry = { ...message("assistant", ""), state: "streaming" };
            session.stream.set(sessionId, entry);
            session.agent.messages.push(entry);
          }
          entry.text += text;
          this.publish(false);
        },
      });
      session.agent.canCancel = true;
      this.update(session);
      await run.claude.completion;
      if (this.closed) return;
      session.threadId = sessionId;
      this.finish(session, true);
    } catch (error) {
      if (this.closed) return;
      const kind = error instanceof ClaudeCodeError ? error.kind : "failed";
      const detail = errorText(error);
      session.agent.queuePaused = session.queue.length > 0;
      if (!this.storageFailed && (kind === "signed-out" || kind === "usage-limit")) this.setProvider(kind, detail);
      this.finish(session, false, detail, kind === "cancelled");
    }
  }

  private async steer(session: AgentSession, text: string) {
    if (!session.agent.canSteer) throw new Error("There is no active turn to steer.");
    if (!this.demo) {
      try {
        await this.server!.call("turn/steer", {
        threadId: session.threadId,
        expectedTurnId: session.run!.turn!.id,
        input: input(text),
        });
      } catch (error) {
        if (errorText(error) === "Timed out calling turn/steer") {
          session.agent.messages.push(message("user", text));
          session.agent.messages.push(message("system", "Codex did not acknowledge this steering message. It may have received it; avoid resending until the turn result is clear.", "warning"));
          this.update(session);
          return;
        }
        throw error;
      }
    } else {
      this.scheduleDemo(session, session.run!);
    }
    session.agent.messages.push(message("user", text));
    this.update(session);
  }

  private finish(session: AgentSession, completed: boolean, detail?: string, cancelled = false) {
    const binding = session.run?.checkTarget;
    if (session.run && !completed) session.run.message.state = cancelled ? "cancelled" : "failed";
    delete session.run;
    if (session.agent.canCancel !== undefined) session.agent.canCancel = false;
    for (const entry of session.stream.values()) {
      if (completed) delete entry.state;
      else entry.state = cancelled ? "cancelled" : "failed";
    }
    session.stream.clear();
    for (const { message } of session.approvals.values()) {
      if (message.approval) message.approval.state = "expired";
    }
    session.approvals.clear();
    if (completed && session.agent.duty === "coder" && session.agent.candidate) {
      try { session.agent.submissionFingerprint = fingerprintCandidate(session.agent.candidate.path); }
      catch (error) { completed = false; detail = `Unable to snapshot the candidate: ${errorText(error)}`; }
    }
    const validation = session.agent.duty === "reviewer" || session.agent.duty === "tester";
    if (completed && validation && !session.agent.check) {
      const summary = "The turn finished without recording a review or test outcome. Request a fresh check with submit_check_result.";
      if (binding) session.agent.check = { submissionId: binding.submissionId, targetAgentId: binding.agentId,
        candidateFingerprint: binding.fingerprint, outcome: "blocked", summary, recordedAt: Date.now() };
      session.agent.messages.push(message("system", summary, "action"));
    }
    session.agent.status = completed
      ? session.agent.duty === "coder" ? "awaiting-confirmation"
        : validation && session.agent.check?.outcome === "changes-requested" ? "error"
          : validation && session.agent.check?.outcome !== "passed" ? "attention" : "done"
      : cancelled ? "idle" : "error";
    if (detail) session.agent.messages.push(message("system", detail, completed || cancelled ? "notice" : "error"));
    if (!completed || !this.drain(session)) this.update(session);
    return completed;
  }

  private captureCheckTarget(session: AgentSession): NonNullable<Run["checkTarget"]> {
    const explicit = session.agent.validationTargetId && this.sessions.get(session.agent.validationTargetId);
    const parent = session.agent.parentId && this.sessions.get(session.agent.parentId);
    const target = explicit || (parent && parent.agent.duty === "coder" ? parent :
      [...this.sessions.values()].find((entry) => this.isActive(entry) && entry.agent.duty === "coder" &&
        entry.agent.parentId === session.agent.parentId && entry.agent.candidate?.path === session.agent.candidate?.path));
    if (!target || !this.isActive(target)) throw new Error("No current validation target is available. Request a check for a specific coder or integration.");
    if (target.agent.role === "lead" && target.agent.integration && session.agent.candidate?.path === target.agent.integration.path) {
      const binding = { agentId: target.agent.id, submissionId: target.agent.integration.id, fingerprint: target.agent.integration.fingerprint };
      this.assertCheckCurrent(binding);
      return binding;
    }
    if (target.agent.duty !== "coder" || !coderIsReady(target.agent) || target.run || target.queue.length || !target.agent.submissionId ||
        target.agent.candidate?.path !== session.agent.candidate?.path) throw new Error("Wait for this coder's current submission before starting validation.");
    const fingerprint = fingerprintCandidate(target.agent.candidate!.path);
    if (target.agent.submissionFingerprint && target.agent.submissionFingerprint !== fingerprint) throw new Error("The candidate changed after submission. Ask the coder to submit it again.");
    return { agentId: target.agent.id, submissionId: target.agent.submissionId, fingerprint };
  }

  private assertCheckCurrent(binding?: Run["checkTarget"]) {
    if (!binding) throw new Error("This check was not bound to a submission when its turn started. Run a fresh check.");
    const target = this.sessions.get(binding.agentId);
    if (!target || !this.isActive(target)) throw new Error("The validation target is no longer active.");
    const integration = target.agent.integration;
    if (target.agent.role === "lead" && integration?.id === binding.submissionId) {
      if (integration.fingerprint !== binding.fingerprint || fingerprintCandidate(integration.path) !== binding.fingerprint) throw new Error("The integration snapshot changed. Rebuild and test it again.");
      for (const source of integration.sources) {
        const coder = this.sessions.get(source.agentId);
        if (!coder || !this.isActive(coder) || coder.run || coder.queue.length || coder.agent.status !== "done" ||
            coder.agent.submissionId !== source.submissionId || !source.fingerprint || !coder.agent.candidate ||
            fingerprintCandidate(coder.agent.candidate.path) !== source.fingerprint) throw new Error("An integration source changed. Confirm its updated submission, rebuild, and retest the integration.");
      }
    } else if (target.agent.submissionId !== binding.submissionId || !coderIsReady(target.agent) || target.run ||
        !target.agent.candidate || fingerprintCandidate(target.agent.candidate.path) !== binding.fingerprint) {
      throw new Error("The coder submission changed. Run a fresh check for the updated submission.");
    }
  }

  private scopedChecks(coder: AgentSession) {
    return [...this.sessions.values()].filter((entry) => this.isActive(entry) &&
      (entry.agent.duty === "reviewer" || entry.agent.duty === "tester") &&
      entry.agent.candidate?.path === coder.agent.candidate?.path &&
      (entry.agent.validationTargetId === coder.agent.id || entry.agent.parentId === coder.agent.id ||
        (!entry.agent.validationTargetId && entry.agent.parentId === coder.agent.parentId)));
  }

  private checkCandidateAccess(session: AgentSession) {
    const candidate = session.agent.candidate?.path;
    if (!candidate) return;
    const conflict = [...this.sessions.values()].some((other) => this.isActive(other) && other !== session &&
      other.agent.candidate?.path === candidate && !other.waitingFor && other.agent.status === "working" &&
      (session.agent.duty === "coder" || other.agent.duty === "coder") && other.agent.role === "worker");
    if (conflict && session.agent.role === "worker") throw new Error("Wait for the current work on this candidate to finish.");
  }

  private reportDelegation(session: AgentSession, completed: boolean, turn?: Turn, result?: string,
    checkOutcome?: NonNullable<WorkspaceAgent["check"]>["outcome"]) {
    if (!session.agent.parentId || this.closed || !this.isActive(session)) return;
    const parent = this.sessions.get(session.agent.parentId);
    const outcome = session.agent.status === "awaiting-confirmation" ? "finished its turn and is awaiting confirmation."
      : completed ? "finished its turn." : "could not complete its turn.";
    const text = `${session.agent.name} ${outcome}${result ? "\n" + result : ""}`;
    const kind = !completed || checkOutcome === "changes-requested" ? "error"
      : checkOutcome === "blocked" ? "warning" : checkOutcome === "passed" ? "success" : "notice";
    for (const recipient of new Set([parent, this.sessions.get(coordinatorId)])) {
      if (recipient && this.isActive(recipient)) {
        recipient.agent.messages.push({ ...message("system", text, kind, session.agent.id),
          reportLabel: checkOutcome === "changes-requested" ? "Review requested" : undefined });
        this.signal(session.agent.id, recipient.agent.id);
      }
    }
    for (const worker of this.sessions.values()) {
      if (!this.isActive(worker) || worker.waitingFor !== session.agent.id) continue;
      delete worker.waitingFor;
      if (completed && this.available && !session.run) void this.startDelegation(worker, turn);
      else if (session.run) worker.waitingFor = session.agent.id;
      else {
        for (const entry of worker.queue.splice(0)) entry.state = "failed";
        worker.agent.queueDepth = 0;
        this.finish(worker, false, "The prerequisite coder turn did not complete. Request this check again when the candidate is ready.");
      }
    }
    this.publish();
  }

  private async startDelegation(worker: AgentSession, parent?: Turn) {
    if (!this.isActive(worker)) return;
    worker.agent.status = "working";
    this.publish();
    try {
      await this.attachThread(worker);
      if (this.closed || !this.isActive(worker)) return;
      const assignment = worker.queue.shift()!;
      await this.begin(worker, assignment, parent);
    } catch (error) {
      for (const entry of worker.queue.splice(0)) entry.state = "failed";
      this.finish(worker, false, errorText(error));
      this.reportDelegation(worker, false);
    }
  }

  private drain(session: AgentSession) {
    if (!this.isActive(session) || !this.available || session.run || session.approvals.size || session.agent.queuePaused ||
        session.agent.unavailableReason || (!this.demo && this.state.provider.name === "codex" && !session.threadId) || !session.queue.length) return false;
    try { this.checkCandidateAccess(session); } catch { return false; }
    void this.begin(session, session.queue.shift()!);
    return true;
  }

  private onEvent({ method, params }: Event) {
    const session = params.threadId ? this.threadSessions.get(params.threadId) : undefined;
    if (method === "error") {
      const detail = errorText(params.error?.message ?? params.message ?? "Codex reported an error.");
      if (/usage.?limit|rate.?limit|quota/i.test(detail)) {
        this.setProvider("usage-limit", detail);
        for (const session of this.sessions.values()) session.agent.canSteer = false;
      } else if (params.willRetry && /reconnect/i.test(detail)) {
        this.setProvider("connecting", detail);
        for (const session of this.sessions.values()) session.agent.canSteer = false;
      }
      if (!this.available) {
        for (const session of this.sessions.values()) {
          for (const pending of session.approvals.values()) {
            if (pending.requestId === undefined) continue;
            this.server!.reply(pending.requestId, { decision: "decline" });
            this.expireApproval(session, pending);
          }
        }
      }
      this.publish();
      return;
    }
    if (!session?.run) return;
    if (method === "serverRequest/resolved") {
      const pending = [...session.approvals.values()].find((entry) => entry.requestId === params.requestId);
      if (pending) this.expireApproval(session, pending);
      return;
    }
    if (method === "turn/started" && params.turn && !session.run.turn) {
      session.freshThread = false;
      session.run.turn = params.turn;
      this.update(session);
    }
    if (method === "turn/completed" && params.turn && (!session.run.turn || params.turn.id === session.run.turn.id)) {
      const completed = params.turn.status === "completed";
      const cancelled = params.turn.status === "interrupted";
      if (completed && this.state.provider.state === "connecting") this.setProvider("ready");
      else if (!completed && this.state.provider.state === "connecting") {
        this.setProvider("error", errorText(params.turn.error?.message ?? "Codex connection failed."));
      }
      const result = completed ? session.agent.messages.slice(session.run.messageOffset ?? 0)
        .findLast((entry) => entry.role === "assistant")?.text : undefined;
      let check = completed ? session.run.check : undefined;
      if (check) {
        try { this.assertCheckCurrent(session.run.checkTarget); }
        catch (error) { check = { ...check, outcome: "blocked", summary: `Validation became stale: ${errorText(error)}` }; }
        session.agent.check = check;
      }
      if (cancelled) session.agent.queuePaused = session.queue.length > 0;
      const detail = params.turn.error?.message ?? (cancelled ? "The turn was interrupted." : "The turn did not complete.");
      const finalized = this.finish(session, completed, completed ? undefined : errorText(detail), cancelled);
      check = session.agent.check ?? check;
      this.reportDelegation(session, finalized, params.turn, check ? `**${check.outcome}**\n\n${check.summary}` : result, check?.outcome);
      return;
    }
    if (!session.run.turn || params.turnId !== session.run.turn.id) return;
    if (this.fileApprovalPolicy(session) === "on-request") this.trackFilePatch(session, session.run, method, params);
    if (method === "item/agentMessage/delta" && params.itemId) {
      const { delta } = params as typeof params & { delta?: string };
      if (typeof delta !== "string") return;
      let entry = session.stream.get(params.itemId);
      if (!entry) {
        entry = { ...message("assistant", ""), state: "streaming", providerItemId: params.itemId };
        session.stream.set(params.itemId, entry);
        session.agent.messages.push(entry);
      }
      entry.text += delta;
      this.publish(false);
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const { id, text } = params.item as typeof params.item & { id?: string };
      if (typeof text !== "string") return;
      const entry = id ? session.stream.get(id) : undefined;
      if (entry) {
        entry.text = text;
        delete entry.state;
        session.stream.delete(id!);
      } else session.agent.messages.push({ ...message("assistant", text), providerItemId: id });
      this.publish();
    }
  }

  private trackFilePatch(session: AgentSession, run: Run, method: string, params: Event["params"]) {
    const fileItem = params.item?.type === "fileChange" ? params.item : undefined;
    if (method === "item/started" && fileItem?.id && Array.isArray(fileItem.changes)) {
      (run.patches ??= new Map()).set(fileItem.id, fileItem.changes);
      return;
    }
    const updated = method === "item/fileChange/patchUpdated";
    const itemId = updated ? params.itemId : method === "item/completed" ? fileItem?.id : undefined;
    if (!itemId) return;
    run.patches?.delete(itemId);
    const pending = [...session.approvals.values()].find((entry) => entry.itemId === itemId);
    if (pending) {
      if (updated) this.server!.reply(pending.requestId!, { decision: "decline" });
      this.expireApproval(session, pending);
    }
    if (updated && Array.isArray(params.changes)) (run.patches ??= new Map()).set(itemId, params.changes);
  }

  private async onRequest({ id, method, params }: Event & { id: Id }) {
    const session = params.threadId ? this.threadSessions.get(params.threadId) : undefined;
    const turn = session?.run?.turn;
    const valid = Boolean(session && this.isActive(session) && turn && turn.id === params.turnId);
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      if (method === "item/fileChange/requestApproval" && valid && session && this.available && !this.closed &&
          this.fileApprovalPolicy(session) === "on-request" && params.grantRoot == null && params.itemId &&
          ![...session.approvals.values()].some((entry) => entry.itemId === params.itemId)) {
        const patch = session.run?.patches?.get(params.itemId);
        const patchPreview = patch && describeWorktreePatch(this.sessionCwd(session), patch);
        if (patchPreview) {
          const reason = typeof params.reason === "string" ? errorText(params.reason).slice(0, 1000) : "";
          const request = message("system", `File change approval in the feature worktree${reason ? "\nCodex reason: " + reason : ""}\n\n${patchPreview}`, "action");
          request.approval = { id: request.id, state: "pending" };
          const pending = { requestId: id, message: request, turnId: turn!.id, itemId: params.itemId, patchPreview };
          session.agent.messages.push(request);
          session.approvals.set(request.id, pending);
          this.update(session);
          if (this.storageFailed) {
            this.server!.reply(id, { decision: "decline" });
            this.expireApproval(session, pending);
          }
          return;
        }
      }
      this.server!.reply(id, { decision: "decline" });
      const conversation = session && this.isActive(session) ? session : this.sessions.get(coordinatorId);
      conversation?.agent.messages.push(message("system", session
        ? method === "item/commandExecution/requestApproval" ? "Orchestra declined a command approval request."
          : "Orchestra declined a file change request without a current, verifiable patch confined to the feature worktree."
        : "Orchestra declined an approval request from a Codex thread outside the workspace.", "warning"));
      this.publish();
      return;
    }
    if (method !== "item/tool/call") {
      this.server!.reject(id, "This request is not supported by the workspace.");
      return;
    }
    const reply = (success: boolean, text: string) => this.server!.reply(id, { success, contentItems: [{ type: "inputText", text }] });
    try {
      if (!valid || !session || !turn || params.namespace != null) {
        reply(false, "This tool is unavailable for the current turn.");
        return;
      }
      if (params.tool === decisionTool.name) {
        const question = typeof params.arguments?.question === "string" ? params.arguments.question.trim() : "";
        if (!question || question.length > 4000) throw new Error("Provide a product question of up to 4,000 characters.");
        const parent = session.agent.parentId ? this.sessions.get(session.agent.parentId) : undefined;
        for (const recipient of new Set([parent, this.sessions.get(coordinatorId)])) {
          if (recipient && this.isActive(recipient)) {
            recipient.agent.messages.push(message("system", `Product decision from ${session.agent.name}: ${question}`, "action", session.agent.id));
            this.signal(session.agent.id, recipient.agent.id);
          }
        }
        this.publish();
        reply(true, "Product decision posted in the parent and pilot chats.");
        return;
      }
      if (params.tool === checkTool.name) {
        if (session.agent.duty !== "reviewer" && session.agent.duty !== "tester") {
          throw new Error("Only a reviewer or tester can submit a check result.");
        }
        const outcome = params.arguments?.outcome;
        const summary = typeof params.arguments?.summary === "string" ? params.arguments.summary.trim() : "";
        if ((outcome !== "passed" && outcome !== "changes-requested" && outcome !== "blocked") ||
          !summary || summary.length > 24_000) throw new Error("Provide a valid outcome and summary.");
        const binding = session.run!.checkTarget;
        this.assertCheckCurrent(binding);
        session.run!.check = { submissionId: binding!.submissionId, targetAgentId: binding!.agentId,
          candidateFingerprint: binding!.fingerprint, outcome, summary, recordedAt: Date.now() };
        reply(true, "Check result recorded for this turn.");
        return;
      }
      if (session.agent.role === "worker" && session.agent.duty !== "coder") throw new Error("Workers can raise product decisions through their parent.");
      if (params.tool === inspectGitTool.name) {
        reply(true, JSON.stringify(inspectGit(this.sessionCwd(session))));
        return;
      }
      const reports = this.subtree(session).filter((entry) => entry !== session && this.isActive(entry));
      if (params.tool === reportTool.name) {
        const target = [...this.sessions.values()].find((entry) => entry.agent.id === params.arguments?.agentId);
        if (!target || !reports.includes(target)) {
          throw new Error("Choose an agent on your team.");
        }
        const { name, status, check, messages } = target.agent;
        const latest = messages.findLast((entry) => entry.role === "assistant" && !entry.state);
        reply(true, JSON.stringify({ name, status, check, latestReport: latest?.text.slice(0, 24_000) }));
        return;
      }
      if (params.tool === confirmCoderTool.name) {
        const coder = reports.find((entry) => entry.agent.id === params.arguments?.agentId && entry.agent.duty === "coder");
        if (session.agent.role !== "lead" || coder?.agent.status !== "awaiting-confirmation" || coder.run || coder.queue.length) {
          throw new Error("Choose a coder on your team whose submission is awaiting confirmation.");
        }
        if (coder.agent.parentId !== session.agent.id || !coder.agent.candidate || !coder.agent.submissionId) throw new Error("Only this coder's team lead can accept its submission.");
        const fingerprint = fingerprintCandidate(coder.agent.candidate.path);
        if (coder.agent.submissionFingerprint && coder.agent.submissionFingerprint !== fingerprint) throw new Error("The candidate changed after submission. Ask the coder to submit it again.");
        const checks = this.scopedChecks(coder);
        if (checks.some((entry) => entry.run || entry.waitingFor || entry.agent.status === "working")) {
          throw new Error("Wait for this coder's scheduled review and testing to finish before confirming.");
        }
        for (const duty of ["reviewer", "tester"] as const) {
          const latest = checks.filter((entry) => entry.agent.duty === duty && entry.agent.check &&
            entry.agent.check.submissionId === coder.agent.submissionId &&
            (!entry.agent.check.targetAgentId || entry.agent.check.targetAgentId === coder.agent.id))
            .map((entry) => entry.agent.check!).sort((a, b) => b.recordedAt - a.recordedAt)[0];
          if (latest?.outcome !== "passed" || latest.candidateFingerprint !== fingerprint) {
            throw new Error(`The current submission needs a fresh passing ${duty} report for this exact candidate. ${latest?.summary ?? "Request a fresh check."}`);
          }
        }
        coder.agent.submissionFingerprint = fingerprint;
        coder.agent.status = "done";
        const notice = `${session.agent.name} confirmed ${coder.agent.name}'s implementation.`;
        for (const recipient of [coder, session, this.sessions.get(coordinatorId)]) {
          recipient?.agent.messages.push(message("system", notice, "success", session.agent.id));
        }
        this.signal(session.agent.id, coder.agent.id);
        this.signal(session.agent.id, coordinatorId);
        this.publish();
        reply(true, notice);
        return;
      }
      if (params.tool === integrateTool.name) {
        if (session.agent.role !== "lead") throw new Error("Only a team lead can integrate accepted coder candidates.");
        const ids = params.arguments?.agentIds;
        if (!Array.isArray(ids) || ids.length < 2 || ids.length > 30 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
          throw new Error("Choose at least two distinct accepted coder agentIds from your team.");
        }
        if (reports.some((entry) => entry.agent.validationTargetId === session.agent.id && entry.run)) throw new Error("Wait for the current integration validation to finish.");
        const sources = ids.map((id) => {
          const coder = reports.find((entry) => entry.agent.id === id && entry.agent.duty === "coder" && entry.agent.parentId === session.agent.id);
          if (!coder || coder.run || coder.recovery || coder.queue.length || coder.agent.status !== "done" || !coder.agent.candidate ||
              !coder.agent.submissionId || !coder.agent.submissionFingerprint) throw new Error("Every integration source must be a confirmed, idle coder submission from this team.");
          const fingerprint = fingerprintCandidate(coder.agent.candidate.path);
          if (fingerprint !== coder.agent.submissionFingerprint) throw new Error("A coder candidate changed after acceptance. Resubmit and validate it first.");
          return { agentId: id, ...coder.agent.candidate, submissionId: coder.agent.submissionId, expectedFingerprint: fingerprint };
        });
        const combined = integrateCandidates(this.state.project.path, sources);
        session.agent.integration = { id: randomUUID(), ...combined };
        const notice = `Integration candidate created at ${combined.path}. Delegate an independent tester without afterAgentId, then confirm_integration. Project files and branch are unchanged.`;
        session.agent.messages.push(message("system", notice, "notice"));
        this.publish();
        reply(true, JSON.stringify(session.agent.integration));
        return;
      }
      if (params.tool === confirmIntegrationTool.name) {
        if (session.agent.role !== "lead" || !session.agent.integration) throw new Error("Only a team lead with an integration candidate can confirm it.");
        const integration = session.agent.integration;
        const binding = { agentId: session.agent.id, submissionId: integration.id, fingerprint: integration.fingerprint };
        this.assertCheckCurrent(binding);
        const testers = reports.filter((entry) => entry.agent.duty === "tester" && entry.agent.validationTargetId === session.agent.id &&
          entry.agent.candidate?.path === integration.path);
        if (testers.some((entry) => entry.run || entry.waitingFor || entry.queue.length)) throw new Error("Wait for all scheduled integration testing to finish.");
        const latest = testers.filter((entry) => entry.agent.check?.submissionId === integration.id && entry.agent.check.targetAgentId === session.agent.id)
          .map((entry) => entry.agent.check!).sort((a, b) => b.recordedAt - a.recordedAt)[0];
        if (latest?.outcome !== "passed" || latest.candidateFingerprint !== integration.fingerprint) throw new Error("The combined snapshot needs a fresh passing integration tester report.");
        integration.confirmed = true;
        const notice = "The combined integration snapshot passed independent testing and is accepted. User approval is required before merging into the project branch; Orchestra has not merged it.";
        session.agent.messages.push(message("system", notice, "success"));
        this.sessions.get(coordinatorId)?.agent.messages.push(message("system", notice, "success", session.agent.id));
        this.publish();
        reply(true, notice);
        return;
      }
      if (params.tool === listTool.name) {
        reply(true, JSON.stringify(reports.map(({ agent }) => ({
          id: agent.id, parentId: agent.parentId, name: agent.name, role: agent.role, duty: agent.duty, goal: agent.goal, status: agent.status,
          submissionId: agent.submissionId, validationTargetId: agent.validationTargetId, candidate: agent.candidate?.path, check: agent.check,
        }))));
        return;
      }
      const goal = typeof params.arguments?.goal === "string" ? params.arguments.goal.trim() : "";
      if (!goal || goal.length > 24_000) throw new Error("Provide a goal of up to 24,000 characters.");
      if (params.tool === relayTool.name) {
        const recipient = reports.find((entry) => entry.agent.id === params.arguments?.agentId);
        if (!recipient?.threadId) throw new Error("Choose an open descendant on your team.");
        this.checkCandidateAccess(recipient);
        const instruction = message("user", goal);
        recipient.agent.messages.push(instruction);
        await this.enqueue(recipient, instruction);
        if (instruction.state !== "failed") this.signal(session.agent.id, recipient.agent.id);
        reply(instruction.state !== "failed", instruction.state === "failed" ? "The turn could not start." : "Instruction delivered.");
        return;
      }
      if (params.tool !== tool.name) throw new Error("Unknown workspace tool.");
      const name = typeof params.arguments?.name === "string" ? params.arguments.name.trim() : "";
      const duty = params.arguments?.duty ?? (session.agent.role === "coordinator" ? "lead" : "analyser");
      if (!name || name.length > 60) throw new Error("Provide an agent name of up to 60 characters.");
      if ([...this.sessions.values()].filter((entry) => this.isActive(entry)).length >= 30) throw new Error("The workspace has reached its 30-session limit.");
      if (duty !== "lead" && duty !== "coder" && duty !== "reviewer" && duty !== "tester" && duty !== "analyser" && duty !== "designer" && duty !== "pm") {
        throw new Error("Choose lead, coder, reviewer, tester, analyser, designer, or product adviser.");
      }
      if ((duty === "lead" && session.agent.role !== "coordinator") || (duty === "coder" && session.agent.role !== "lead")) {
        throw new Error("The pilot starts leads. A lead starts coders.");
      }
      const checkDuty = duty === "tester" || duty === "reviewer" || duty === "designer";
      if (session.agent.duty === "coder" && !checkDuty) throw new Error("Coders may delegate only reviewer, tester, or designer checks for their own work.");
      const after = params.arguments?.afterAgentId ?? (session.agent.duty === "coder" ? session.agent.id : undefined);
      const prerequisite = after === undefined ? undefined : session.agent.duty === "coder" && after === session.agent.id
        ? session : reports.find((entry) => entry.agent.id === after && entry.agent.duty === "coder");
      if (after !== undefined && (!prerequisite || !checkDuty ||
          (!prerequisite.run && !coderIsReady(prerequisite.agent) && prerequisite.agent.status !== "working"))) {
        throw new Error("Schedule review, design review, or testing after an active or completed coder on your team.");
      }
      const integrationCheck = !prerequisite && checkDuty && session.agent.role === "lead" ? session.agent.integration : undefined;
      if (!prerequisite && (duty === "reviewer" || duty === "tester") && session.agent.role === "lead" && !integrationCheck) {
        throw new Error("Set afterAgentId to the coder to validate, or create an integration candidate first.");
      }
      const candidate = duty === "coder" ? createFeatureWorktree(this.state.project.path)
        : prerequisite?.agent.candidate ?? (integrationCheck ? { path: integrationCheck.path, base: integrationCheck.base } : session.agent.candidate);
      const parentId = prerequisite?.agent.id ?? session.agent.id;
      const agent = this.createAgent(randomUUID(), name, duty === "lead" ? "lead" : "worker", parentId, goal);
      agent.agent.duty = duty === "lead" ? undefined : duty;
      agent.agent.candidate = candidate;
      if (prerequisite || integrationCheck) agent.agent.validationTargetId = prerequisite?.agent.id ?? session.agent.id;
      if (duty === "coder") {
        const notice = `Feature worktree for ${name}: ${candidate!.path}`;
        session.agent.messages.push(message("system", notice, "notice"));
        this.sessions.get(coordinatorId)?.agent.messages.push(message("system", notice, "notice"));
      }
      try {
        if (!prerequisite || (!prerequisite.run && coderIsReady(prerequisite.agent))) this.checkCandidateAccess(agent);
      } catch (error) {
        this.sessions.delete(agent.agent.id);
        this.state.agents.pop();
        throw error;
      }
      const assignment = message("user", goal);
      assignment.state = "queued";
      agent.agent.messages.push(assignment);
      agent.queue.push(assignment);
      if (prerequisite && (prerequisite.run || !coderIsReady(prerequisite.agent))) {
        agent.waitingFor = prerequisite.agent.id;
        agent.agent.queueDepth = 1;
        this.publish();
      } else {
        await this.startDelegation(agent, turn);
      }
      if (agent.agent.status !== "error") this.signal(session.agent.id, agent.agent.id);
      reply(agent.agent.status !== "error", JSON.stringify({
        id: agent.agent.id, name, duty, waitingFor: agent.waitingFor, candidate: agent.agent.candidate?.path,
      }));
    } catch (error) {
      reply(false, errorText(error));
    }
  }

  private expireApproval(session: AgentSession, pending: PendingApproval) {
    if (pending.message.approval) pending.message.approval.state = "expired";
    session.approvals.delete(pending.message.id);
    this.update(session);
  }

  private resolveApproval(session: AgentSession, approvalId: string, decision: "accept" | "decline") {
    if (decision !== "accept" && decision !== "decline") throw new Error("Unknown approval decision.");
    const approval = session.approvals.get(approvalId);
    if (!approval?.message.approval || (approval.turnId && approval.turnId !== session.run?.turn?.id)) {
      throw new Error("This approval is no longer active.");
    }
    if (decision === "accept" && approval.message.approval.canAccept === false) {
      throw new Error("Codex did not offer approval for this request.");
    }
    if (decision === "accept" && approval.itemId) {
      const patch = session.run?.patches?.get(approval.itemId);
      if (!patch || describeWorktreePatch(this.sessionCwd(session), patch) !== approval.patchPreview) {
        this.server!.reply(approval.requestId!, { decision: "decline" });
        this.expireApproval(session, approval);
        throw new Error("The file change could no longer be verified in the feature worktree.");
      }
    }
    if (approval.requestId !== undefined) this.server!.reply(approval.requestId, { decision });
    approval.message.approval.state = decision === "accept" ? "accepted" : "declined";
    session.approvals.delete(approvalId);
    if (!session.run) session.agent.status = "done";
    this.update(session);
    if (this.demo && session.run && !session.approvals.size) this.scheduleDemo(session, session.run);
  }

  private scheduleDemo(session: AgentSession, run: Run) {
    if (run.demoTimer || session.approvals.size) return;
    run.demoTimer = setTimeout(() => {
      if (this.closed || session.run !== run) return;
      session.agent.messages.push(message("assistant", session.agent.role === "coordinator"
        ? "Demo received your goal. Select a lead or worker to explore its conversation."
        : "Demo received your message. This turn is complete."));
      const finalized = this.finish(session, true);
      this.reportDelegation(session, finalized, undefined, session.agent.check?.summary, session.agent.check?.outcome);
    }, 900);
  }

  private seedDemo() {
    const coordinator = this.sessions.get(coordinatorId)!;
    coordinator.agent.messages.push(
      message("user", "Prepare the release. Check the workspace interactions and review the delivery workflow."),
      message("assistant", "I’ve split the release into two teams. Select any agent to inspect progress or send a message."),
    );
    const workspace = this.createAgent("workspace-lead", "Workspace lead", "lead", coordinatorId, "Build the workspace");
    const delivery = this.createAgent("delivery-lead", "Delivery lead", "lead", coordinatorId, "Verify parallel delivery");
    const canvas = this.createAgent("canvas-worker", "Canvas", "worker", workspace.agent.id, "Radial layout and navigation");
    const conversations = this.createAgent("chat-worker", "Conversations", "worker", workspace.agent.id, "Chat docks and drafts");
    const accessibility = this.createAgent("accessibility-worker", "Accessibility", "worker", workspace.agent.id, "Keyboard and focus review");
    const test = this.createAgent("test-worker", "Testing", "worker", delivery.agent.id, "Exercise the delivery checks");
    const review = this.createAgent("review-worker", "Review", "worker", delivery.agent.id, "Review the combined diff");
    const integration = this.createAgent("integration-worker", "Integration", "worker", delivery.agent.id, "Integrate squad changes");
    canvas.agent.duty = "coder";
    conversations.agent.duty = "coder";
    accessibility.agent.duty = "analyser";
    test.agent.duty = "tester";
    review.agent.duty = "reviewer";
    integration.agent.duty = "coder";
    workspace.agent.messages.push(message("assistant", "Canvas, conversations, and accessibility are tracking separate parts of the workspace."));
    delivery.agent.messages.push(message("assistant", "The integration candidate is ready for a review of its combined checks."));
    const canvasTask = message("user", "Verify the layout stays anchored when the chat docks move.");
    canvas.agent.messages.push(canvasTask, message("assistant", "I’m checking the canvas anchor while the docks open and close."));
    canvas.run = { message: canvasTask };
    this.update(canvas);
    conversations.agent.status = "done";
    conversations.agent.messages.push(message("assistant", "The composer preserves a separate draft for each conversation."));
    accessibility.agent.status = "notice";
    accessibility.agent.messages.push(message("assistant", "Keyboard navigation is ready to inspect."));
    test.agent.status = "error";
    test.agent.messages.push(message("system", "The combined delivery check failed. The candidate is still available for inspection.", "error"));
    review.agent.status = "idle";
    review.agent.messages.push(message("assistant", "Send me a message to start reviewing the candidate."));
    const task = message("user", "Check the candidate branch name.");
    const request = message("system", "Command approval\ngit branch --show-current\nRead the branch name in the demo worktree.");
    request.approval = { id: request.id, state: "pending" };
    integration.agent.messages.push(task, request);
    integration.run = { message: task };
    integration.approvals.set(request.id, { message: request });
    this.update(integration);
  }
}
