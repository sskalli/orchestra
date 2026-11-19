import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { AppServer, safeError } from "./app-server.ts";
import type { Event, Id, Thread, Turn } from "./app-server.ts";
import { createFeatureWorktree } from "./workspace-worktree.ts";
import type { SavedSession, workspaceStore } from "./workspace-store.ts";
import { defaultProject, workspaceIdentity } from "./workspace-projects.ts";
import type { WorkspaceProject } from "./workspace-projects.ts";

export type AgentStatus = "idle" | "working" | "attention" | "awaiting-confirmation" | "done" | "error" | "notice";
export type AgentRole = "coordinator" | "lead" | "worker";
export type SystemMessageKind = "error" | "action" | "warning" | "notice" | "success";
export type WorkspaceMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  kind?: SystemMessageKind;
  sourceAgentId?: string;
  reportLabel?: string;
  providerItemId?: string;
  state?: "queued" | "streaming" | "failed";
  approval?: { id: string; state: "pending" | "accepted" | "declined" | "expired"; canAccept?: boolean };
};
export type WorkspaceAgent = {
  id: string;
  name: string;
  role: AgentRole;
  parentId?: string;
  projectId?: string;
  goal?: string;
  duty?: Duty;
  candidate?: Candidate;
  submissionId?: string;
  check?: { submissionId: string; outcome: "passed" | "changes-requested" | "blocked"; summary: string; recordedAt: number };
  status: AgentStatus;
  messages: WorkspaceMessage[];
  queueDepth: number;
  queuePaused?: boolean;
  unavailableReason?: string;
  canSteer: boolean;
  simulation?: boolean;
};
export type WorkspaceSnapshot = {
  project: { name: string; path: string };
  modelProvider: string;
  projects: WorkspaceProject[];
  workspaceKey: string;
  provider: { state: "demo" | "connecting" | "ready" | "signed-out" | "error" | "usage-limit"; message?: string };
  agents: WorkspaceAgent[];
};
export type AgentSignal = { id: string; senderId: string; recipientId: string };
export type WorkspaceCommand =
  | { type: "send" | "steer"; agentId: string; text: string }
  | { type: "resumeQueue"; agentId: string }
  | { type: "approval"; agentId: string; approvalId: string; decision: "accept" | "decline" };

type Candidate = { path: string; base: string };
type Duty = "coder" | "reviewer" | "tester" | "analyser" | "designer" | "pm";

type Run = { turn?: Turn; messageOffset?: number; message: WorkspaceMessage; check?: WorkspaceAgent["check"]; demoTimer?: ReturnType<typeof setTimeout> };
type AgentSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  freshThread?: boolean;
  toolVersion?: number;
  waitingFor?: string;
  run?: Run;
  recovery?: SavedSession["run"];
  queue: WorkspaceMessage[];
  stream: Map<string, WorkspaceMessage>;
  approvals: Map<string, { requestId?: Id; message: WorkspaceMessage; turnId?: string }>;
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
  description: "Start an addressable team lead, coder, reviewer, tester, analyser, designer, or product adviser. In a multi-repository workspace the pilot must set projectId to a configured project ID. A lead's workers inherit its project. Set afterAgentId to wait for a specific active coder before starting review, design review, or testing.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, goal: { type: "string" },
      duty: { type: "string", enum: ["lead", "coder", "reviewer", "tester", "analyser", "designer", "pm"] },
      projectId: { type: "string" },
      afterAgentId: { type: "string" } },
    required: ["name", "goal", "duty"],
    additionalProperties: false,
  },
};
const inspectGitTool = {
  type: "function",
  deferLoading: false,
  name: "inspect_project_git",
  description: "Read current local branches, HEAD, and worktree status. The pilot must specify projectId in a multi-repository workspace; leads inspect their assigned project.",
  inputSchema: { type: "object", properties: { projectId: { type: "string" } }, additionalProperties: false },
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
  description: "Send an instruction to an existing direct report. Use the ID from delegation or list_agents.",
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
  description: "List direct reports, their IDs, roles, goals, and statuses.",
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
  private readonly projects: WorkspaceProject[];
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

  constructor({ cwd, projects = [defaultProject(cwd)], demo = false, provider = "openai", store }: {
    cwd: string;
    projects?: WorkspaceProject[];
    demo?: boolean;
    provider?: string;
    store?: ReturnType<typeof workspaceStore>;
  }) {
    if (!projects.length || new Set(projects.map((project) => project.id)).size !== projects.length ||
        new Set(projects.map((project) => resolve(project.path))).size !== projects.length) {
      throw new Error("Workspace projects must have unique IDs and paths.");
    }
    this.projects = projects.map((project) => ({ id: project.id, path: resolve(project.path) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const path = this.projects[0].path;
    this.demo = demo;
    this.providerId = provider;
    this.store = demo ? undefined : store;
    this.state = {
      project: { name: this.projects.length === 1 ? basename(path) : "Workspace", path },
      projects: this.projects,
      workspaceKey: workspaceIdentity(this.projects),
      modelProvider: provider,
      provider: { state: demo ? "demo" : "connecting" },
      agents: [],
    };
    this.createAgent(coordinatorId, "Coordinator", "coordinator");
    if (demo) this.seedDemo();
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
      saved = this.store?.load()?.filter(({ agent }) => !agent.simulation);
      if (saved) this.restore(saved);
      this.storageReady = true;
    } catch (error) {
      this.storageFailed = true;
      this.state.provider = { state: "error", message: errorText(error) };
      this.publish();
      return;
    }
    const server = new AppServer(this.state.project.path, process.env, false);
    this.server = server;
    server.onEvent = (event) => this.onEvent(event);
    server.onRequest = (event) => this.onRequest(event);
    server.onFailure = (error) => {
      const detail = errorText(error);
      this.state.provider = { state: "error", message: detail };
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
          this.state.provider = { state: "signed-out", message: "Sign in to Codex with ChatGPT, then restart the workspace." };
          this.publish();
          return;
        }
      }
      const coordinator = this.sessions.get(coordinatorId)!;
      if (!coordinator.threadId) await this.attachThread(coordinator);
      for (const entry of saved ?? []) {
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
      if (!this.storageFailed && !this.closed) this.state.provider = { state: "ready" };
    } catch (error) {
      this.state.provider = { state: "error", message: errorText(error) };
    }
    this.publish();
  }

  async close() {
    this.persist();
    this.closed = true;
    for (const timer of this.simulationTimers) clearTimeout(timer);
    this.simulationTimers.clear();
    for (const session of this.sessions.values()) clearTimeout(session.run?.demoTimer);
    this.listeners.clear();
    this.signalListeners.clear();
    await this.server?.close();
  }

  async command(command: WorkspaceCommand) {
    if (this.closed) throw new Error("The workspace is closed.");
    const session = this.sessions.get(command.agentId);
    if (!session) throw new Error("This conversation no longer exists.");
    if (command.type === "send" && session.agent.id === coordinatorId &&
        /^\/simulate\s+team-messages(?:\s|$)/.test(command.text.trim())) {
      if (this.simulationRunning) throw new Error("The message simulation is already running.");
      this.simulateTeamMessages(session);
      return;
    }
    if (session.agent.simulation) throw new Error("This agent belongs to the local message simulation. Start a new simulation from the main chat.");
    if (!this.available || session.agent.unavailableReason) {
      throw new Error(session.agent.unavailableReason ?? this.state.provider.message ?? "Codex is unavailable.");
    }
    if (!this.demo && !session.threadId) throw new Error("This Codex conversation is still opening or failed to open.");
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

  private async enqueue(session: AgentSession, next: WorkspaceMessage) {
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
      recipient.agent.messages.push(message("system", text, done ? "success" : "notice", sender.agent.id));
      recipient.agent.status = done ? "done" : "working";
      this.signal(sender.agent.id, recipient.agent.id);
      this.publish();
    };
    const later = (action: () => void) => {
      const timer = setTimeout(() => {
        this.simulationTimers.delete(timer);
        if (!this.closed) action();
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
      const sessions = [...this.sessions.values()].filter(({ agent }) => !agent.simulation);
      this.store.save(sessions.map(({ agent, threadId, freshThread, run, recovery, waitingFor, toolVersion }) => ({
        waitingFor,
        toolVersion,
        agent,
        threadId: run || recovery || (!freshThread && hasSubmittedMessage(agent)) ? threadId : undefined,
        run: run ? { messageId: run.message.id, turnId: run.turn?.id } : recovery,
      })));
      return true;
    } catch (error) {
      this.storageFailed = true;
      this.state.provider = { state: "error", message: `Workspace changes could not be saved. ${errorText(error)}` };
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
    const parent = parentId ? this.sessions.get(parentId) : undefined;
    const agent: WorkspaceAgent = { id, name, role, parentId, goal, projectId: parent?.agent.projectId,
      status: "idle", messages: [], queueDepth: 0, canSteer: false };
    const session: AgentSession = { agent, queue: [], stream: new Map(), approvals: new Map() };
    this.state.agents.push(agent);
    this.sessions.set(id, session);
    return session;
  }

  private restore(saved: SavedSession[]) {
    const entries = new Map(saved.map((entry) => [entry.agent.id, entry]));
    if (this.projects.length === 1) {
      for (const { agent } of saved) {
        if (agent.role !== "coordinator") agent.projectId = this.projects[0].id;
      }
    }
    for (const { agent } of saved) {
      if (agent.role === "coordinator") continue;
      if (!this.projects.some((project) => project.id === agent.projectId)) {
        throw new Error(`Saved agent ${agent.name} has an unknown project.`);
      }
      const parent = agent.parentId && entries.get(agent.parentId)?.agent;
      if (!parent || (parent.role !== "coordinator" && parent.projectId !== agent.projectId)) {
        throw new Error(`Saved agent ${agent.name} has an invalid project assignment.`);
      }
    }
    this.sessions.clear();
    this.state.agents.length = 0;
    for (const { agent, threadId, run, waitingFor } of saved) {
      const session = this.createAgent(agent.id, agent.name, agent.role, agent.parentId, agent.goal);
      Object.assign(session.agent, agent, { canSteer: false });
      if (session.agent.duty === "coder" && session.agent.status === "done" && !session.agent.submissionId) {
        session.agent.status = "awaiting-confirmation";
        session.agent.messages.push(message("system", "This earlier confirmation did not record review and test results. Ask the lead to recheck the submission.", "action"));
      }
      if (session.agent.duty === "coder" && session.agent.status === "awaiting-confirmation" && !session.agent.submissionId) {
        session.agent.submissionId = randomUUID();
      }
      session.threadId = run || hasSubmittedMessage(agent) ? threadId : undefined;
      session.recovery = run;
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
      const refreshTools = (session.agent.role !== "worker" || session.agent.duty === "reviewer" ||
        session.agent.duty === "tester") && toolVersion !== managementToolVersion;
      if (thread.status?.type === "active" || turn && turn.status === "inProgress") {
        if (!refreshTools) throw new Error("Codex still reports an active turn. Check again after restarting the workspace.");
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
    if (session.agent.candidate) return session.agent.candidate.path;
    if (session.agent.role === "coordinator") return this.projects[0].path;
    return this.projectForAgent(session).path;
  }

  private projectForAgent(session: AgentSession) {
    const project = this.projects.find((entry) => entry.id === session.agent.projectId);
    if (!project) throw new Error("This agent has no configured project.");
    return project;
  }

  private selectProject(session: AgentSession, requested: unknown) {
    if (session.agent.role !== "coordinator") {
      const project = this.projectForAgent(session);
      if (requested !== undefined && requested !== project.id) throw new Error("A team cannot change its assigned project.");
      return project;
    }
    if (requested === undefined && this.projects.length === 1) return this.projects[0];
    const project = this.projects.find((entry) => entry.id === requested);
    if (!project) throw new Error(`Choose a projectId from: ${this.projects.map((entry) => entry.id).join(", ")}.`);
    return project;
  }

  private threadPermissions(session: AgentSession) {
    return {
      sandbox: session.agent.duty === "coder" ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      runtimeWorkspaceRoots: [this.sessionCwd(session)],
    };
  }

  private instructions(session: AgentSession) {
    const role = session.agent.role === "worker" ? session.agent.duty ?? "analyser" : session.agent.role;
    const instructions = readFileSync(new URL(`../roles/${role}.md`, import.meta.url), "utf8");
    const projectContext = session.agent.role === "coordinator"
      ? `Configured projects (ID and repository root): ${JSON.stringify(this.projects)}. ` +
        (this.projects.length === 1
          ? "Follow the project's AGENTS.md for coding conventions, commands, and local workflow."
          : "Specify projectId when delegating or inspecting Git. Ask the user if the intended project is unclear. Never guess a project.")
      : `Your assigned project is ${this.projectForAgent(session).id}; its source repository is ${this.projectForAgent(session).path}. ` +
        `Your working directory is ${this.sessionCwd(session)}. Stay in that working directory and follow its AGENTS.md. ` +
        (session.agent.candidate ? "Work on the candidate worktree, not the original checkout." : "");
    return `${projectContext}\nUse Orchestra's tools for delegation and product questions.\n\n${instructions}`;
  }

  private async attachThread(session: AgentSession) {
    const { thread, modelProvider } = await this.server!.call<{ thread: Thread; modelProvider: string }>("thread/start", {
      cwd: this.sessionCwd(session),
      model: process.env.CODEX_MODEL,
      modelProvider: this.providerId,
      ...this.threadPermissions(session),
      config: workspaceThreadConfig,
      ephemeral: false,
      ...(session.agent.role !== "worker" && { environments: [] }),
      dynamicTools: session.agent.role === "worker"
        ? [decisionTool, ...(session.agent.duty === "reviewer" || session.agent.duty === "tester" ? [checkTool] : [])]
        : [tool, relayTool, listTool, inspectGitTool, reportTool, decisionTool, ...(session.agent.role === "lead" ? [confirmCoderTool] : [])],
      developerInstructions: this.instructions(session),
    });
    if (modelProvider !== this.providerId || this.threadSessions.has(thread.id)) throw new Error("Codex returned an unexpected thread.");
    session.threadId = thread.id;
    session.freshThread = true;
    session.toolVersion = managementToolVersion;
    this.threadSessions.set(thread.id, session);
    this.publish();
  }

  private teamReportContext(session: AgentSession) {
    if (session.agent.role === "worker") return undefined;
    const team = [...this.sessions.values()].filter((entry) => entry.agent.parentId &&
      (session.agent.role === "coordinator" || entry.agent.parentId === session.agent.id));
    const reports = team.map(({ agent }) => {
      const recent = agent.messages.findLast((entry) => entry.role === "assistant" && !entry.state);
      return {
        agentId: agent.id, parentId: agent.parentId, projectId: agent.projectId, name: agent.name, duty: agent.duty,
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
    const run: Run = { message: next, messageOffset: session.agent.messages.length };
    if (session.agent.duty === "coder") session.agent.submissionId = randomUUID();
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
    try {
      const { turn } = await this.server!.call<{ turn: Turn }>("turn/start", {
        threadId: session.threadId,
        approvalPolicy: "never",
        ...(session.agent.role !== "worker" && { environments: [] }),
        ...(session.agent.candidate && {
          cwd: this.sessionCwd(session),
          runtimeWorkspaceRoots: [this.sessionCwd(session)],
          approvalPolicy: "never",
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

  private finish(session: AgentSession, completed: boolean, detail?: string) {
    if (session.run && !completed) session.run.message.state = "failed";
    delete session.run;
    for (const entry of session.stream.values()) {
      if (completed) delete entry.state;
      else entry.state = "failed";
    }
    session.stream.clear();
    for (const { message } of session.approvals.values()) {
      if (message.approval) message.approval.state = "expired";
    }
    session.approvals.clear();
    session.agent.status = completed
      ? (session.agent.duty === "coder" ? "awaiting-confirmation" : "done")
      : "error";
    if (detail) session.agent.messages.push(message("system", detail, completed ? "notice" : "error"));
    if (!completed || !this.drain(session)) this.update(session);
  }

  private checkCandidateAccess(session: AgentSession) {
    const candidate = session.agent.candidate?.path;
    if (!candidate) return;
    const conflict = [...this.sessions.values()].some((other) => other !== session &&
      other.agent.candidate?.path === candidate && !other.waitingFor && other.agent.status === "working" &&
      (session.agent.duty === "coder" || other.agent.duty === "coder") && other.agent.role === "worker");
    if (conflict && session.agent.role === "worker") throw new Error("Wait for the current work on this candidate to finish.");
  }

  private reportDelegation(session: AgentSession, completed: boolean, turn?: Turn, result?: string,
    checkOutcome?: NonNullable<WorkspaceAgent["check"]>["outcome"]) {
    if (!session.agent.parentId || this.closed) return;
    const parent = this.sessions.get(session.agent.parentId);
    const outcome = session.agent.status === "awaiting-confirmation" ? "finished its turn and is awaiting confirmation."
      : completed ? "finished its turn." : "could not complete its turn.";
    const text = `${session.agent.name} ${outcome}${result ? "\n" + result : ""}`;
    const kind = !completed || checkOutcome === "changes-requested" ? "error"
      : checkOutcome === "blocked" ? "warning" : checkOutcome === "passed" ? "success" : "notice";
    for (const recipient of new Set([parent, this.sessions.get(coordinatorId)])) {
      if (recipient) {
        recipient.agent.messages.push({ ...message("system", text, kind, session.agent.id),
          reportLabel: checkOutcome === "changes-requested" ? "Review requested" : undefined });
        this.signal(session.agent.id, recipient.agent.id);
      }
    }
    for (const worker of this.sessions.values()) {
      if (worker.waitingFor !== session.agent.id) continue;
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
    worker.agent.status = "working";
    this.publish();
    try {
      await this.attachThread(worker);
      if (this.closed) return;
      const assignment = worker.queue.shift()!;
      await this.begin(worker, assignment, parent);
    } catch (error) {
      for (const entry of worker.queue.splice(0)) entry.state = "failed";
      this.finish(worker, false, errorText(error));
      this.reportDelegation(worker, false);
    }
  }

  private drain(session: AgentSession) {
    if (!this.available || session.run || session.approvals.size || session.agent.queuePaused ||
        session.agent.unavailableReason || (!this.demo && !session.threadId) || !session.queue.length) return false;
    try { this.checkCandidateAccess(session); } catch { return false; }
    void this.begin(session, session.queue.shift()!);
    return true;
  }

  private onEvent({ method, params }: Event) {
    const session = params.threadId ? this.threadSessions.get(params.threadId) : undefined;
    if (method === "error") {
      const detail = errorText(params.error?.message ?? params.message ?? "Codex reported an error.");
      if (/usage.?limit|rate.?limit|quota/i.test(detail)) {
        this.state.provider = { state: "usage-limit", message: detail };
        for (const session of this.sessions.values()) session.agent.canSteer = false;
      } else if (params.willRetry && /reconnect/i.test(detail)) {
        this.state.provider = { state: "connecting", message: detail };
        for (const session of this.sessions.values()) session.agent.canSteer = false;
      }
      this.publish();
      return;
    }
    if (!session?.run) return;
    if (method === "turn/started" && params.turn && !session.run.turn) {
      session.freshThread = false;
      session.run.turn = params.turn;
      this.update(session);
    }
    if (method === "turn/completed" && params.turn && (!session.run.turn || params.turn.id === session.run.turn.id)) {
      const completed = params.turn.status === "completed";
      if (completed && this.state.provider.state === "connecting") this.state.provider = { state: "ready" };
      else if (!completed && this.state.provider.state === "connecting") {
        this.state.provider = { state: "error", message: errorText(params.turn.error?.message ?? "Codex connection failed.") };
      }
      const result = completed ? session.agent.messages.slice(session.run.messageOffset ?? 0)
        .findLast((entry) => entry.role === "assistant")?.text : undefined;
      const check = completed ? session.run.check : undefined;
      if (check) session.agent.check = check;
      this.finish(session, completed, completed ? undefined : errorText(params.turn.error?.message ?? "The turn did not complete."));
      this.reportDelegation(session, completed, params.turn, check ? `**${check.outcome}**\n\n${check.summary}` : result, check?.outcome);
      return;
    }
    if (!session.run.turn || params.turnId !== session.run.turn.id) return;
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

  private async onRequest({ id, method, params }: Event & { id: Id }) {
    const session = params.threadId ? this.threadSessions.get(params.threadId) : undefined;
    const turn = session?.run?.turn;
    const valid = Boolean(session && turn && turn.id === params.turnId);
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.server!.reply(id, { decision: "decline" });
      const conversation = session ?? this.sessions.get(coordinatorId);
      conversation?.agent.messages.push(message("system", session
        ? "Orchestra declined an out-of-sandbox request. Implementation must run in the coder’s feature worktree."
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
          if (recipient) {
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
        const coder = [...this.sessions.values()].find((entry) => entry.agent.duty === "coder" &&
          entry.agent.parentId === session.agent.parentId && entry.agent.candidate?.path === session.agent.candidate?.path &&
          coderIsReady(entry.agent));
        if (!coder?.agent.submissionId) throw new Error("No current coder submission is available for this check.");
        session.run!.check = { submissionId: coder.agent.submissionId, outcome, summary, recordedAt: Date.now() };
        reply(true, "Check result recorded for this turn.");
        return;
      }
      if (session.agent.role === "worker") throw new Error("Workers can raise product decisions through their parent.");
      if (params.tool === inspectGitTool.name) {
        const project = this.selectProject(session, params.arguments?.projectId);
        reply(true, JSON.stringify(inspectGit(session.agent.role === "coordinator" ? project.path : this.sessionCwd(session))));
        return;
      }
      const reports = [...this.sessions.values()].filter((entry) => entry.agent.parentId === session.agent.id);
      if (params.tool === reportTool.name) {
        const target = [...this.sessions.values()].find((entry) => entry.agent.id === params.arguments?.agentId);
        if (!target || (target.agent.parentId !== session.agent.id && session.agent.role !== "coordinator")) {
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
        if (reports.some((entry) => (entry.agent.duty === "reviewer" || entry.agent.duty === "tester") &&
          (entry.run || entry.waitingFor || entry.agent.status === "working"))) {
          throw new Error("Wait for scheduled review and testing to finish before confirming.");
        }
        for (const duty of ["reviewer", "tester"] as const) {
          const latest = reports.filter((entry) => entry.agent.duty === duty && entry.agent.check &&
            entry.agent.check.submissionId === coder.agent.submissionId)
            .map((entry) => entry.agent.check!)
            .sort((a, b) => b.recordedAt - a.recordedAt)[0];
          if (latest?.outcome !== "passed") {
            throw new Error(`The current submission needs a passing ${duty} report. ${latest?.summary ?? "Request a fresh check."}`);
          }
        }
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
      if (params.tool === listTool.name) {
        reply(true, JSON.stringify(reports.map(({ agent }) => ({
          id: agent.id, projectId: agent.projectId, name: agent.name, role: agent.role, duty: agent.duty, goal: agent.goal, status: agent.status, check: agent.check?.outcome,
        }))));
        return;
      }
      const goal = typeof params.arguments?.goal === "string" ? params.arguments.goal.trim() : "";
      if (!goal || goal.length > 24_000) throw new Error("Provide a goal of up to 24,000 characters.");
      if (params.tool === relayTool.name) {
        const recipient = reports.find((entry) => entry.agent.id === params.arguments?.agentId);
        if (!recipient?.threadId) throw new Error("Choose an open direct report.");
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
      if (this.sessions.size >= 30) throw new Error("The workspace has reached its 30-session limit.");
      if (duty !== "lead" && duty !== "coder" && duty !== "reviewer" && duty !== "tester" && duty !== "analyser" && duty !== "designer" && duty !== "pm") {
        throw new Error("Choose lead, coder, reviewer, tester, analyser, designer, or product adviser.");
      }
      if ((duty === "lead" && session.agent.role !== "coordinator") || (duty === "coder" && session.agent.role !== "lead")) {
        throw new Error("The pilot starts leads. A lead starts coders.");
      }
      const project = this.selectProject(session, params.arguments?.projectId);
      if (duty === "coder" && reports.some((entry) => entry.agent.duty === "coder" &&
        (entry.agent.threadId || entry.agent.status === "working"))) {
        throw new Error("This team already has a coder. Use message_agent to send feedback to that same conversation.");
      }
      const after = params.arguments?.afterAgentId;
      const prerequisite = after === undefined ? undefined : reports.find((entry) =>
        entry.agent.id === after && entry.agent.duty === "coder");
      if (after !== undefined && (!prerequisite || (duty !== "tester" && duty !== "reviewer" && duty !== "designer") ||
          (!prerequisite.run && !coderIsReady(prerequisite.agent) && prerequisite.agent.status !== "working"))) {
        throw new Error("Schedule review, design review, or testing after an active or completed coder on this team.");
      }
      if (duty === "coder" && !session.agent.candidate) {
        session.agent.candidate = createFeatureWorktree(project.path);
        const notice = `Feature worktree for ${session.agent.name}: ${session.agent.candidate.path}`;
        session.agent.messages.push(message("system", notice, "notice"));
        this.sessions.get(coordinatorId)?.agent.messages.push(message("system", notice, "notice"));
      }
      const agent = this.createAgent(randomUUID(), name, duty === "lead" ? "lead" : "worker", session.agent.id, goal);
      agent.agent.projectId = project.id;
      agent.agent.duty = duty === "lead" ? undefined : duty;
      agent.agent.candidate = session.agent.candidate;
      try {
        if (!prerequisite || coderIsReady(prerequisite.agent)) this.checkCandidateAccess(agent);
      } catch (error) {
        this.sessions.delete(agent.agent.id);
        this.state.agents.pop();
        throw error;
      }
      const assignment = message("user", goal);
      assignment.state = "queued";
      agent.agent.messages.push(assignment);
      agent.queue.push(assignment);
      if (prerequisite && !coderIsReady(prerequisite.agent)) {
        agent.waitingFor = prerequisite.agent.id;
        agent.agent.queueDepth = 1;
        this.publish();
      } else {
        await this.startDelegation(agent, turn);
      }
      if (agent.agent.status !== "error") this.signal(session.agent.id, agent.agent.id);
      reply(agent.agent.status !== "error", JSON.stringify({
        id: agent.agent.id, projectId: project.id, name, duty, waitingFor: agent.waitingFor, candidate: agent.agent.candidate?.path,
      }));
    } catch (error) {
      reply(false, errorText(error));
    }
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
      this.finish(session, true);
      this.reportDelegation(session, true);
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
