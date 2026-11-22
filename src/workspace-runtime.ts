import { WorkspaceUsage } from "./workspace-usage.ts";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppServer, safeError } from "./app-server.ts";
import type { Event, Id, Thread, Turn } from "./app-server.ts";
import { createFeatureWorktree, removeFeatureWorktree } from "./workspace-worktree.ts";
import { fingerprintCandidate, fingerprintIntegrationMembers, fingerprintMemberSnapshots, pinApprovedCandidate, pinDirectCandidates, validateCandidateWorktree, type IntegrationMember } from "./workspace-integration.ts";
import { recordReportedModel, selectModelSettings } from "./workspace-models.ts";
import type { ModelSettings, ReportedModel } from "./workspace-models.ts";
import type { SavedSession, workspaceStore } from "./workspace-store.ts";
import { defaultProject, workspaceIdentity } from "./workspace-projects.ts";
import type { WorkspaceProject } from "./workspace-projects.ts";

export type AgentStatus = "idle" | "working" | "attention" | "awaiting-confirmation" | "done" | "error" | "notice";
export type AgentRole = "worker";
export type SystemMessageKind = "error" | "action" | "warning" | "notice" | "success";
export type WorkspaceMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  kind?: SystemMessageKind;
  providerItemId?: string;
  orchestrationRunId?: string;
  state?: "queued" | "streaming" | "failed" | "cancelled";
  productQuestion?: { status: "pending" } | { status: "answered"; answerMessageId: string };
  answersProductQuestionId?: string;
};
export type WorkspaceAgent = {
  id: string;
  name: string;
  role: AgentRole;
  parentId?: string;
  projectId?: string;
  goal?: string;
  duty?: Duty;
  modelSettings?: ModelSettings;
  candidate?: Candidate;
  nativeChild?: true;
  directTask?: { projectIds: string[]; phase: "planning" | "implementing" | "blocked" | "ready-for-review"; detail?: string };
  directCandidates?: (Candidate & { projectId: string })[];
  integration?: { id: string; path: string; base: string; fingerprint: string; sources: { agentId: string; submissionId: string; head: string; fingerprint?: string; projectId?: string }[]; members?: IntegrationMember[]; validationEvidence?: CheckResult };
  status: AgentStatus;
  messages: WorkspaceMessage[];
  queueDepth: number;
  queuePaused?: boolean;
  unavailableReason?: string;
  canSteer: boolean;
  canCancel?: boolean;
  archivedAt?: number;
  lifecycleBusy?: boolean;
  lifecycleBlockedReason?: string;
};
export type WorkspaceProvider = "codex";
export type WorkspaceSnapshot = {
  project: { name: string; path: string };
  modelProvider: string;
  projects: WorkspaceProject[];
  workspaceKey: string;
  provider: { name: WorkspaceProvider; state: "demo" | "connecting" | "ready" | "signed-out" | "error" | "usage-limit"; message?: string };
  agents: WorkspaceAgent[];
  usage?: Omit<ReturnType<WorkspaceUsage["summary"]>, "byRun"> & { issue?: string };
};
export type AgentSignal = { id: string; senderId: string; recipientId: string };
export type WorkspaceCommand =
  | { type: "createTask"; name: string; projectIds: string[] }
  | { type: "answerProductQuestion"; agentId: string; questionId: string; text: string }
  | { type: "startImplementation"; agentId: string; text?: string }
  | { type: "send" | "steer"; agentId: string; text: string }
  | { type: "resumeQueue" | "cancel" | "restore" | "delete"; agentId: string }
  | { type: "archive"; agentId: string; stopRunning?: boolean };

type Candidate = { path: string; base: string };
type CheckResult = { submissionId: string; candidateFingerprint: string;
  outcome: "passed" | "changes-requested" | "blocked"; summary: string; recordedAt: number };
type Duty = "lead" | "coder" | "reviewer" | "tester" | "analyser" | "designer" | "pm";

type Run = {
  taskImplementation?: boolean;
  steered?: boolean;
  turn?: Turn;
  message: WorkspaceMessage;
  check?: CheckResult;
  demoTimer?: ReturnType<typeof setTimeout>;
};
type AgentSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  freshThread?: boolean;
  toolVersion?: number;
  run?: Run;
  recovery?: SavedSession["run"];
  opening?: boolean;
  queue: WorkspaceMessage[];
  stream: Map<string, WorkspaceMessage>;
};

const taskToolVersion = 14;
const legacyQuestionResolutionPrefix = "Resolve product question: ";
const workspaceThreadConfig = { "features.multi_agent": true, "features.multi_agent_v2": true };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const hasSubmittedMessage = (agent: WorkspaceAgent) =>
  agent.messages.some((entry) => entry.role === "user" && entry.state !== "queued");
const checkTool = {
  type: "function",
  name: "submit_check_result",
  description: "Record the result of the assigned verification. Use passed only when the required scope passed, changes-requested for findings or failures, or blocked when verification could not finish.",
  inputSchema: {
    type: "object",
    properties: { outcome: { type: "string", enum: ["passed", "changes-requested", "blocked"] }, summary: { type: "string" } },
    required: ["outcome", "summary"], additionalProperties: false,
  },
};

const resolveQuestionTool = {
  type: "function",
  deferLoading: false,
  name: "resolve_product_question",
  description: "Mark a pending product question answered only if the current user message actually answers it.",
  inputSchema: {
    type: "object",
    properties: { questionId: { type: "string" } },
    required: ["questionId"],
    additionalProperties: false,
  },
};
const decisionTool = {
  type: "function",
  deferLoading: false,
  name: "raise_product_decision",
  description: "Ask the user a question about the current task and end the turn.",
  inputSchema: { type: "object", properties: { question: { type: "string" } },
    required: ["question"], additionalProperties: false },
};

function message(role: WorkspaceMessage["role"], text: string, kind?: SystemMessageKind): WorkspaceMessage {
  return { id: randomUUID(), role, text, ...(kind ? { kind } : {}) };
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
  private usage?: WorkspaceUsage;
  private usageIssue?: string;
  private started = false;
  private closed = false;

  constructor({ cwd, projects = [defaultProject(cwd)], demo = false, modelProvider = "openai", store }: {
    cwd: string;
    projects?: WorkspaceProject[];
    demo?: boolean;
    modelProvider?: string;
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
    this.providerId = modelProvider;
    this.store = demo ? undefined : store;
    this.state = {
      project: { name: this.projects.length === 1 ? basename(path) : "Workspace", path },
      projects: this.projects,
      workspaceKey: workspaceIdentity(this.projects),
      modelProvider,
      provider: { name: "codex", state: demo ? "demo" : "connecting" },
      agents: [],
    };
    if (demo) this.seedDemo();
  }

  private setProvider(state: WorkspaceSnapshot["provider"]["state"], detail?: string) {
    this.state.provider = { name: this.state.provider.name, state, message: detail };
  }

  snapshot(): WorkspaceSnapshot {
    const usage = this.usage ?? (this.usageIssue ? new WorkspaceUsage() : undefined);
    const state = this.state;
    if (!usage) return structuredClone(state);
    const { total, byAgent, unattributedTokens } = usage.summary();
    return structuredClone({
      ...state, usage: { total, byAgent, unattributedTokens, issue: this.usageIssue },
    });
  }

  usageExport() {
    if (!this.usage) return undefined;
    return { version: 1, modelProvider: this.providerId, ...this.usage.snapshot() };
  }

  private trackUsage(update: (usage: WorkspaceUsage) => void) {
    if (!this.usage) return;
    try {
      update(this.usage);
    } catch {
      this.usage = undefined;
      this.usageIssue = "Usage tracking is unavailable because its local records could not be read or saved.";
    }
  }

  private trackTurn(session: AgentSession, threadId: string, turnId: string, entry: WorkspaceMessage, recovered = false) {
    this.trackUsage((usage) => usage.registerTurn(threadId, turnId, {
      agentId: session.agent.id,
      runId: entry.orchestrationRunId ?? entry.id,
      model: session.agent.modelSettings?.reportedModel ?? session.agent.modelSettings?.requestedModel,
    }, recovered));
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
    try {
      this.usage = new WorkspaceUsage(this.store?.usagePath, this.store?.previousUsagePath);
      this.trackUsage((usage) => usage.retainAgents([...this.sessions.keys()]));
    } catch {
      this.usageIssue = "Usage tracking is unavailable because its local records could not be read.";
    }
    const server = new AppServer(this.state.project.path);
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
      for (const entry of saved ?? []) {
        if (entry.agent.archivedAt) continue;
        if (entry.agent.nativeChild) {
          await this.resumeNativeChild(this.sessions.get(entry.agent.id)!);
          continue;
        }
        if (entry.threadId && this.sessions.get(entry.agent.id)?.threadId === entry.threadId) {
          await this.resumeThread(entry);
        } else if (entry.agent.directTask) {
          const session = this.sessions.get(entry.agent.id)!;
          try {
            await this.attachThread(session);
            delete session.agent.unavailableReason;
          } catch (error) {
            session.agent.unavailableReason = errorText(error);
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
    for (const session of this.sessions.values()) clearTimeout(session.run?.demoTimer);
    this.listeners.clear();
    this.signalListeners.clear();
    await this.server?.close();
  }

  async command(command: WorkspaceCommand) {
    if (this.closed) throw new Error("The workspace is closed.");
    if (command.type === "createTask") return this.createDirectTask(command.name, command.projectIds);
    const session = this.sessions.get(command.agentId);
    if (!session) throw new Error("This conversation no longer exists.");
    if (session.agent.nativeChild) throw new Error("Use the owning task to interact with this Codex subagent.");
    if (command.type === "archive" || command.type === "restore" || command.type === "delete") {
      await this.lifecycle(session, command);
      return;
    }
    if (!this.isActive(session)) throw new Error("Restore this archived conversation before messaging it.");
    if (command.type === "startImplementation") {
      await this.startDirectTaskImplementation(session, command.text);
      return;
    }
    if (command.type === "cancel") {
      await this.interrupt(session);
      return;
    }
    if (!this.available || session.agent.unavailableReason) {
      throw new Error(session.agent.unavailableReason ?? this.state.provider.message ?? "The provider is unavailable.");
    }
    if (!this.demo && !session.threadId) throw new Error("This Codex conversation is still opening or failed to open.");
    if (command.type === "resumeQueue") {
      if (!session.agent.queuePaused || !session.queue.length || session.run) throw new Error("There is no paused queue to resume.");
      session.agent.queuePaused = false;
      this.drain(session);
      return;
    }
    if (command.type !== "send" && command.type !== "steer" && command.type !== "answerProductQuestion") {
      throw new Error("Unknown workspace command.");
    }
    const text = typeof command.text === "string" ? command.text.trim() : "";
    if (!text || text.length > 24_000) throw new Error("Enter a message of 1–24,000 characters.");
    if (command.type === "steer") {
      await this.steer(session, text);
      return;
    }
    if (command.type === "answerProductQuestion") {
      this.answerProductQuestion(session, command.questionId, text);
      return;
    }
    const next = message("user", text);
    session.agent.messages.push(next);
    await this.enqueue(session, next);
  }

  private answerProductQuestion(session: AgentSession, questionId: string, text: string) {
    const question = session.agent.directTask
      ? session.agent.messages.find((entry) => entry.id === questionId)
      : undefined;
    if (question?.productQuestion?.status !== "pending") {
      throw new Error("This product question is no longer awaiting an answer in this task.");
    }
    const answer = { ...message("user", text), answersProductQuestionId: question.id, state: "queued" as const };
    question.productQuestion = { status: "answered", answerMessageId: answer.id };
    session.agent.messages.push(answer);
    session.queue.push(answer);
    if (!this.persist()) {
      session.queue.pop();
      session.agent.messages.pop();
      question.productQuestion = { status: "pending" };
      this.publish(false);
      throw new Error("Orchestra could not save the answer. The question remains pending.");
    }
    if (!this.drain(session)) this.update(session);
  }

  private async createDirectTask(name: string, projectIds: string[]) {
    if (!this.available || this.demo || this.storageFailed) {
      throw new Error("Codex must be ready to create a task.");
    }
    const title = typeof name === "string" ? name.trim() : "";
    if (!title || title.length > 60) throw new Error("Provide a task name of up to 60 characters.");
    if (!Array.isArray(projectIds) || new Set(projectIds).size !== projectIds.length ||
        projectIds.some((id) => !this.projects.some((project) => project.id === id))) {
      throw new Error("Choose distinct configured repositories.");
    }
    if ([...this.sessions.values()].filter((entry) => this.isActive(entry)).length >= 30) {
      throw new Error("The workspace has reached its 30-session limit.");
    }
    const session = this.createAgent(randomUUID(), title, "worker");
    session.agent.projectId = projectIds[0];
    session.agent.directTask = { projectIds: [...projectIds], phase: "planning" };
    try {
      await this.attachThread(session);
      if (this.storageFailed) throw new Error("Orchestra could not save the new task.");
      return session.agent.id;
    } catch (error) {
      this.sessions.delete(session.agent.id);
      if (session.threadId) this.threadSessions.delete(session.threadId);
      this.state.agents = this.state.agents.filter((agent) => agent !== session.agent);
      this.publish();
      throw error;
    }
  }

  private async startDirectTaskImplementation(session: AgentSession, text?: string) {
    const task = session.agent.directTask;
    if (!task?.projectIds.length) throw new Error("Choose at least one repository for an implementation task.");
    if (!this.available || this.storageFailed || !session.threadId || session.agent.unavailableReason) {
      throw new Error("This Codex task is unavailable.");
    }
    if (session.run || session.opening || session.recovery || session.queue.length ||
        task.phase === "implementing") {
      throw new Error("Wait for the task to finish its current turn before approving implementation.");
    }
    if (this.hasRunningNativeChildren(session)) {
      throw new Error("Wait for this task's Codex subagents to finish before approving implementation.");
    }
    if (!session.agent.messages.some((entry) => entry.role === "assistant" && !entry.state)) {
      throw new Error("Discuss the task in this chat before approving implementation.");
    }
    if (text !== undefined && (typeof text !== "string" || text.length > 24_000)) {
      throw new Error("Keep the implementation instruction within 24,000 characters.");
    }
    if (!session.agent.candidate) {
      const candidates: NonNullable<WorkspaceAgent["directCandidates"]> = [];
      try {
        for (const projectId of task.projectIds) {
          const project = this.projects.find(({ id }) => id === projectId)!;
          candidates.push({ ...createFeatureWorktree(project.path), projectId });
        }
      } catch (error) {
        for (const { path, projectId } of candidates) {
          removeFeatureWorktree(this.projects.find(({ id }) => id === projectId)!.path, path);
        }
        throw error;
      }
      const [candidate] = candidates;
      session.agent.candidate = { path: candidate.path, base: candidate.base };
      if (candidates.length > 1) session.agent.directCandidates = candidates;
    }
    const roots = this.directTaskCandidates(session);
    for (const candidate of roots) {
      const project = this.projects.find(({ id }) => id === candidate.projectId)!;
      validateCandidateWorktree(project.path, candidate);
    }
    const assignment = message("user",
      (text?.trim() || "Implement the plan we agreed in this chat.") +
      "\n\nImplementation is explicitly approved for this turn. Write only in these isolated worktrees: " +
      JSON.stringify(roots.map(({ projectId, path }) => ({ projectId, path }))) +
      ". Keep implementation edits in this session. Wait for any subagents to finish, then run the agreed verification and call submit_check_result before ending the turn.");
    task.phase = "implementing";
    delete task.detail;
    delete session.agent.integration;
    session.agent.messages.push(assignment);
    await this.begin(session, assignment, true);
  }

  private directTaskCandidates(session: AgentSession) {
    const { candidate, directCandidates, projectId } = session.agent;
    return directCandidates ?? (candidate && projectId ? [{ ...candidate, projectId }] : []);
  }

  private finishDirectTask(session: AgentSession, check: CheckResult | undefined, detail?: string) {
    const task = session.agent.directTask!;
    try {
      if (detail) throw new Error(detail);
      if (this.hasRunningNativeChildren(session)) throw new Error("A Codex subagent is still running. Wait for it to finish and verify the candidate again.");
      if (check?.outcome !== "passed") throw new Error(check?.summary ?? "No passing verification was recorded for this turn.");
      const candidates = this.directTaskCandidates(session);
      const members = candidates.map((candidate) => ({ ...candidate, fingerprint: fingerprintCandidate(candidate.path) }));
      if (fingerprintMemberSnapshots(members) !== check.candidateFingerprint) {
        throw new Error("The candidate changed after verification. Recheck the current worktrees.");
      }
      const sources = members.map(({ fingerprint, ...member }) => ({
        ...member, agentId: session.agent.id, submissionId: check.submissionId, expectedFingerprint: fingerprint,
      }));
      if (sources.length > 1) {
        const delivery = pinDirectCandidates(this.projects, sources);
        if (delivery.members?.every(({ base, revision }) => base === revision)) {
          for (const { projectId, path } of delivery.members) {
            removeFeatureWorktree(this.projects.find(({ id }) => id === projectId)!.path, path);
          }
          throw new Error("The task finished without changes to the approved repositories.");
        }
        session.agent.integration = { id: check.submissionId, ...delivery, validationEvidence: check };
      } else {
        const source = sources[0];
        const pinned = pinApprovedCandidate(this.projectForAgent(session).path, source);
        const fingerprint = fingerprintCandidate(pinned.path);
        session.agent.integration = {
          id: check.submissionId, path: pinned.path, base: source.base, fingerprint,
          sources: [{ agentId: session.agent.id, submissionId: check.submissionId, head: pinned.revision }],
          members: [{ ...pinned, projectId: source.projectId, base: source.base, fingerprint }],
          validationEvidence: check,
        };
      }
      task.phase = "ready-for-review";
      session.agent.status = "awaiting-confirmation";
      session.agent.messages.push(message("system", "A verified candidate is ready for review.", "success"));
      return true;
    } catch (error) {
      task.phase = "blocked";
      task.detail = errorText(error);
      session.agent.status = "error";
      session.agent.messages.push(message("system", task.detail, "error"));
      return false;
    }
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

  private hasRunningNativeChildren(root: AgentSession) {
    return this.subtree(root).some(({ agent }) => agent.nativeChild && agent.status === "working" && !agent.archivedAt);
  }

  private async lifecycle(root: AgentSession, command: Extract<WorkspaceCommand, { type: "archive" }> | { type: "restore" | "delete"; agentId: string }) {
    if (this.storageFailed) throw new Error("Resolve the workspace storage failure before changing tasks.");
    if (!this.demo && this.state.provider.state === "connecting") throw new Error("Wait for workspace recovery to finish.");
    const affected = this.subtree(root);
    if (command.type === "restore") {
      if (!root.agent.archivedAt) throw new Error("This agent is not archived.");
    }
    if (affected.some((entry) => entry.agent.lifecycleBusy || entry.opening)) throw new Error("Wait for the current lifecycle or conversation-opening operation to finish.");
    if (command.type !== "restore" && affected.some((entry) => entry.recovery || /active (?:writer|turn)|still be running|unresolved|not acknowledged/i.test(entry.agent.unavailableReason ?? ""))) {
      throw new Error("This task has unresolved provider work. Restart and reconcile it before archiving or deleting.");
    }
    if (command.type !== "restore" && affected.some((entry) => entry.agent.nativeChild && entry.agent.status === "working")) {
      throw new Error("Wait for the Codex subagents to finish before archiving or deleting this task.");
    }
    const running = affected.filter((entry) => entry.run || entry.agent.status === "working");
    if (command.type === "delete" && running.length) {
      throw new Error("Stop and archive this task before deleting running work.");
    }
    if (command.type === "archive" && running.length && !command.stopRunning) {
      throw new Error("This task has running work. Choose Stop and archive.");
    }
    for (const entry of affected) { entry.agent.lifecycleBusy = true; delete entry.agent.lifecycleBlockedReason; }
    this.publish();
    try {
      if (command.type === "archive") {
        const stopped = await Promise.allSettled(running.map(async (entry) => {
          await this.interrupt(entry);
          const deadline = Date.now() + 10_000;
          while (entry.run && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          if (entry.run || entry.recovery) throw new Error("Stopping could not be confirmed. The task remains visible; restart to reconcile provider work.");
        }));
        const failed = stopped.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (affected.some((entry) => entry.run || entry.recovery) ||
            this.subtree(root).some((entry) => entry.agent.nativeChild && (!affected.includes(entry) || entry.agent.status === "working"))) {
          throw new Error("Unresolved work remains. The task has not been archived.");
        }
        const now = Date.now();
        const previous = affected.map((entry) => {
          const { archivedAt, canSteer, canCancel, queuePaused } = entry.agent;
          return { entry, agent: { archivedAt, canSteer, canCancel, queuePaused } };
        });
        for (const entry of affected) {
          entry.agent.archivedAt ??= now;
          entry.agent.canSteer = false;
          entry.agent.canCancel = false;
          entry.agent.queuePaused = entry.queue.length > 0;
        }
        if (!this.persist()) {
          for (const { entry, agent } of previous) Object.assign(entry.agent, agent);
          throw new Error("Archiving could not be saved. The task remains visible; resolve the storage failure before trying again.");
        }
      } else if (command.type === "delete") {
        const ids = new Set(affected.map((entry) => entry.agent.id));
        const previousAgents = [...this.state.agents];
        const previousSessions = [...this.sessions.entries()];
        const previousThreads = [...this.threadSessions.entries()];
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
          throw new Error("Deletion could not be saved. The conversations were kept; resolve the storage failure before trying again.");
        }
        this.trackUsage((usage) => usage.removeAgents([...ids]));
      } else {
        const archiveDates = affected.map((entry) => entry.agent.archivedAt);
        for (const entry of affected) {
          if (!entry.agent.archivedAt) continue;
          delete entry.agent.archivedAt;
          if (!this.demo && this.available) {
            if (entry.threadId && !this.threadSessions.has(entry.threadId)) {
              if (entry.agent.nativeChild) await this.resumeNativeChild(entry);
              else await this.resumeThread({ agent: entry.agent, threadId: entry.threadId, toolVersion: entry.toolVersion });
            } else if (!entry.threadId && entry.agent.directTask) {
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
    if (session.run || session.agent.queuePaused || session.queue.length) {
      next.state = "queued";
      session.queue.push(next);
      this.update(session);
      if (this.demo && session.run) this.scheduleDemo(session, session.run);
      if (!session.run) this.drain(session);
      return;
    }
    await this.begin(session, next);
  }

  private get available() {
    return this.state.provider.state === "ready" || this.state.provider.state === "demo";
  }

  private persist() {
    if (!this.store || !this.storageReady || this.storageFailed) return !this.storageFailed;
    try {
      this.store.save([...this.sessions.values()].map(({ agent, threadId, freshThread, run, recovery, toolVersion }) => ({
        toolVersion,
        agent,
        threadId: agent.nativeChild || agent.archivedAt || run || recovery || (!freshThread && hasSubmittedMessage(agent)) ? threadId : undefined,
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
    const running = Boolean(session.run?.turn || (this.demo && session.run));
    session.agent.canSteer = this.available && running;
    session.agent.canCancel = this.available && running;
    if (session.run) session.agent.status = "working";
    this.publish();
  }

  private createAgent(id: string, name: string, role: AgentRole, parentId?: string, goal?: string) {
    const parent = parentId ? this.sessions.get(parentId) : undefined;
    const agent: WorkspaceAgent = { id, name, role, parentId, goal, projectId: parent?.agent.projectId,
      status: "idle", messages: [], queueDepth: 0, canSteer: false };
    const session: AgentSession = { agent, queue: [], stream: new Map() };
    this.state.agents.push(agent);
    this.sessions.set(id, session);
    return session;
  }

  private restore(saved: SavedSession[]) {
    const entries = new Map(saved.map((entry) => [entry.agent.id, entry]));
    const configuredIds = new Set(this.projects.map(({ id }) => id));
    for (const { agent } of saved) {
      if (agent.directTask) {
        if (this.projects.length === 1 && agent.directTask.projectIds.length === 1) {
          agent.projectId = this.projects[0].id;
          agent.directTask.projectIds = [agent.projectId];
          for (const member of [...(agent.integration?.members ?? []), ...(agent.integration?.sources ?? [])]) {
            member.projectId = agent.projectId;
          }
        }
        const ids = agent.directTask.projectIds;
        if (agent.parentId || agent.nativeChild || agent.projectId !== ids[0] ||
            new Set(ids).size !== ids.length || ids.some((id) => !configuredIds.has(id))) {
          throw new Error(`Saved task ${agent.name} has an invalid repository scope.`);
        }
        const candidates = agent.directCandidates;
        if (candidates && (!Array.isArray(candidates) || candidates.length < 2 || candidates.length !== ids.length ||
            candidates.some((candidate, index) => !candidate || candidate.projectId !== ids[index] ||
              typeof candidate.path !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(candidate.base)) ||
            candidates[0].path !== agent.candidate?.path || candidates[0].base !== agent.candidate?.base ||
            new Set(candidates.map(({ path }) => path)).size !== candidates.length)) {
          throw new Error(`Saved task ${agent.name} has invalid candidate repositories.`);
        }
      } else {
        let parent = agent.parentId ? entries.get(agent.parentId)?.agent : undefined;
        const visited = new Set([agent.id]);
        while (parent?.nativeChild && !visited.has(parent.id)) {
          visited.add(parent.id);
          parent = parent.parentId ? entries.get(parent.parentId)?.agent : undefined;
        }
        if (!agent.nativeChild || !parent?.directTask) {
          throw new Error(`Saved subagent ${agent.name} has an invalid task parent.`);
        }
        agent.projectId = parent.projectId;
      }
    }
    for (const { agent, threadId, run, toolVersion } of saved) {
      const session = this.createAgent(agent.id, agent.name, "worker", agent.parentId, agent.goal);
      Object.assign(session.agent, agent, {
        projectId: agent.projectId, canSteer: false, canCancel: false, lifecycleBusy: undefined,
      });
      session.threadId = agent.nativeChild || agent.archivedAt || run || hasSubmittedMessage(agent) ? threadId : undefined;
      session.toolVersion = toolVersion;
      session.recovery = run;
      session.queue = agent.messages.filter((entry) => entry.state === "queued");
      for (const entry of agent.messages) {
        if (entry.state === "streaming" || entry.id === run?.messageId) entry.state = "failed";
      }
      session.agent.queueDepth = session.queue.length;
      session.agent.queuePaused = session.queue.length > 0;
      if (session.agent.directTask?.phase === "implementing") {
        session.agent.directTask.phase = "blocked";
        session.agent.directTask.detail = "Orchestra restarted during implementation. Review the worktree and run verification again.";
      }
      if (!agent.nativeChild && agent.status === "working") {
        session.agent.status = "error";
        session.agent.messages.push(message("system", "Orchestra restarted during this turn. Check the conversation before sending it again.", "action"));
      }
    }
  }

  private async resumeThread({ agent, threadId, run, toolVersion }: SavedSession) {
    const session = this.sessions.get(agent.id)!;
    if (threadId) {
      this.trackUsage((usage) => usage.registerThread(threadId, false, agent.id));
      const entry = run && agent.messages.find((message) => message.id === run.messageId);
      const turnId = run?.turnId;
      if (entry && turnId) this.trackTurn(session, threadId, turnId, entry, true);
      this.trackUsage((usage) => usage.markResumedThread(threadId, turnId));
    }
    type RecoveredTurn = Turn & { items?: { id: string; type: string; text?: string }[] };
    try {
      const settings = session.agent.modelSettings ?? this.selectModelSettings();
      const response = await this.server!.call<ReportedModel & {
        thread: Thread & { status?: { type: string }; turns?: RecoveredTurn[] };
        modelProvider: string;
        initialTurnsPage?: { data: RecoveredTurn[] };
      }>("thread/resume", {
        threadId, cwd: this.sessionCwd(session), modelProvider: this.providerId,
        model: settings.reportedModel ?? settings.requestedModel,
        ...this.threadPermissions(session),
        config: workspaceThreadConfig,
        developerInstructions: this.instructions(session),
        excludeTurns: true,
        initialTurnsPage: { limit: 8, itemsView: "full" },
      });
      const { thread, modelProvider, initialTurnsPage } = response;
      if (thread.id !== threadId || modelProvider !== this.providerId || this.threadSessions.has(thread.id)) {
        throw new Error("Codex returned an unexpected saved thread.");
      }
      const turn = run?.turnId && (initialTurnsPage?.data ?? thread.turns)?.find((entry) => entry.id === run.turnId);
      if (thread.status?.type === "active" || turn && turn.status === "inProgress") {
        throw new Error("Codex still reports an active turn. Check again after restarting the workspace.");
      }
      this.recordModelSettings(session, settings, response);
      delete session.agent.unavailableReason;
      delete session.recovery;
      this.threadSessions.set(thread.id, session);
      session.toolVersion = toolVersion;
      if (turn && turn.status === "completed") {
        session.agent.status = session.agent.directTask?.phase === "blocked" ? "error"
          : session.agent.directTask?.phase === "ready-for-review" ? "awaiting-confirmation" : "done";
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
      if (run && turn && (turn.status === "failed" || turn.status === "interrupted")) {
        const answer = session.agent.messages.find(({ id }) => id === run.messageId);
        if (answer?.answersProductQuestionId) {
          answer.state = turn.status === "interrupted" ? "cancelled" : "failed";
          this.reopenProductQuestion(session, answer);
        }
      }
    } catch (error) {
      session.agent.unavailableReason = errorText(error);
      session.agent.status = "error";
      session.agent.messages.push(message("system", `Unable to resume this Codex conversation. ${session.agent.unavailableReason}`, "error"));
    }
  }

  private sessionCwd(session: AgentSession) {
    if (!session.agent.projectId) return tmpdir();
    return this.projectForAgent(session).path;
  }

  private projectForAgent(session: AgentSession) {
    const project = this.projects.find((entry) => entry.id === session.agent.projectId);
    if (!project) throw new Error("This agent has no configured project.");
    return project;
  }

  private threadPermissions(session: AgentSession) {
    const roots = this.directTaskReadRoots(session);
    return {
      ...(roots.length ? { runtimeWorkspaceRoots: roots } : { environments: [] }),
      sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user",
    };
  }

  private directTaskReadRoots(session: AgentSession) {
    return session.agent.directTask!.projectIds.map((id) => this.projects.find((project) => project.id === id)!.path);
  }

  private instructions(session: AgentSession) {
    const roots = session.agent.directTask!.projectIds.map((id) => this.projects.find((project) => project.id === id)!);
    return "Work directly with the user in this task. " +
      (roots.length ? `The selected repositories for read-only investigation are ${JSON.stringify(roots)}. ` : "No repositories are selected. ") +
      "Plan and discuss by default. Use raise_product_decision if you need the user to choose, then end the turn. " +
      "When orchestra_pending_questions is supplied, use its question IDs and the resolution tool it indicates only if the current user reply answers that question. Leave unrelated questions open. " +
      "Perform code changes only in a turn explicitly approved for implementation, using its isolated worktree paths. " +
      "Follow the repository instructions. Verify the candidate, call submit_check_result with the actual result, and report blockers concisely.";
  }

  private selectModelSettings(): ModelSettings {
    return selectModelSettings(process.env.CODEX_MODEL);
  }

  private recordModelSettings(session: AgentSession, settings: ModelSettings, response: ReportedModel) {
    const expectedModel = settings.reportedModel ?? settings.requestedModel;
    if (expectedModel && response.model && response.model !== expectedModel) {
      session.agent.messages.push(message("system",
        `Codex reported model ${response.model} instead of ${expectedModel}. Check the provider configuration if this was unexpected.`, "notice"));
    }
    session.agent.modelSettings = recordReportedModel(settings, response);
  }

  private async attachThread(session: AgentSession) {
    session.opening = true;
    try {
    const settings = session.agent.modelSettings ?? this.selectModelSettings();
    const response = await this.server!.call<ReportedModel & { thread: Thread; modelProvider: string }>("thread/start", {
      cwd: this.sessionCwd(session),
      model: settings.reportedModel ?? settings.requestedModel,
      modelProvider: this.providerId,
      ...this.threadPermissions(session),
      config: workspaceThreadConfig,
      ephemeral: false,
      dynamicTools: [decisionTool, checkTool, resolveQuestionTool],
      developerInstructions: this.instructions(session),
    });
    const { thread, modelProvider } = response;
    if (modelProvider !== this.providerId || this.threadSessions.has(thread.id)) throw new Error("Codex returned an unexpected thread.");
    this.recordModelSettings(session, settings, response);
    session.threadId = thread.id;
    this.trackUsage((usage) => usage.registerThread(thread.id, true, session.agent.id));
    session.freshThread = true;
    session.toolVersion = taskToolVersion;
    this.threadSessions.set(thread.id, session);
    this.publish();
    } finally { session.opening = false; }
  }

  private directTaskTurnScope(session: AgentSession, implementation: boolean) {
    const roots = implementation ? this.directTaskCandidates(session).map(({ path }) => path) : this.directTaskReadRoots(session);
    return {
      cwd: roots[0] ?? tmpdir(),
      ...(roots.length ? { runtimeWorkspaceRoots: roots } : { environments: [] }),
      sandboxPolicy: implementation
        ? { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "readOnly", networkAccess: false },
    };
  }

  private pendingQuestionContext(session: AgentSession, answer: WorkspaceMessage, implementation: boolean) {
    if (implementation || answer.answersProductQuestionId) return undefined;
    const questions = session.agent.messages.slice(0, session.agent.messages.indexOf(answer))
      .filter((entry) => entry.productQuestion?.status === "pending");
    if (!questions.length) return undefined;
    // Existing Codex threads retain their original tool definitions.
    const resolve = session.toolVersion === taskToolVersion
      ? "call resolve_product_question with its questionId"
      : `call raise_product_decision with its question argument set to "${legacyQuestionResolutionPrefix}<question ID>"`;
    return {
      orchestra_pending_questions: {
        kind: "untrusted", name: "orchestra_pending_questions",
        value: JSON.stringify({
          instruction: `If the current user message answers a pending question, ${resolve}. Leave other questions pending.`,
          questions: questions.map(({ id, text }) => ({ id, text })),
        }),
      },
    };
  }

  private resolveProductQuestion(session: AgentSession, questionId: unknown) {
    const run = session.run;
    if (!session.agent.directTask || !run || run.taskImplementation || run.steered || run.message.answersProductQuestionId) {
      throw new Error("Only a normal reply in this task can resolve a pending product question.");
    }
    const answer = run.message;
    const question = session.agent.messages.slice(0, session.agent.messages.indexOf(answer))
      .find(({ id }) => id === questionId);
    if (question?.productQuestion?.status !== "pending") throw new Error("Choose a pending question from before this reply in the current task.");
    question.productQuestion = { status: "answered", answerMessageId: answer.id };
    answer.answersProductQuestionId = question.id;
    if (!this.persist()) {
      this.reopenProductQuestion(session, answer);
      delete answer.answersProductQuestionId;
      this.publish(false);
      throw new Error("Orchestra could not save the answer. The question remains pending.");
    }
    this.publish(false);
  }

  private reopenProductQuestion(session: AgentSession, answer: WorkspaceMessage) {
    if (!answer.answersProductQuestionId) return;
    const question = session.agent.messages.find(({ id }) => id === answer.answersProductQuestionId);
    if (question?.productQuestion?.status === "answered" && question.productQuestion.answerMessageId === answer.id) {
      question.productQuestion = { status: "pending" };
    }
  }

  private answerInput(session: AgentSession, entry: WorkspaceMessage) {
    if (!entry.answersProductQuestionId) return entry.text;
    const question = session.agent.messages.find(({ id }) => id === entry.answersProductQuestionId);
    return question?.productQuestion
      ? `My answer to this product decision:\n\n${question.text}\n\nAnswer: ${entry.text}`
      : entry.text;
  }

  private async begin(session: AgentSession, next: WorkspaceMessage, taskImplementation = false) {
    if (!this.isActive(session)) return;
    const run: Run = { message: next, taskImplementation };
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
        ...this.directTaskTurnScope(session, taskImplementation),
        input: input(this.answerInput(session, next)),
        additionalContext: this.pendingQuestionContext(session, next, taskImplementation),
      });
      session.freshThread = false;
      if (session.threadId) this.trackTurn(session, session.threadId, turn.id, next);
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
      }
    }
  }

  private async interrupt(session: AgentSession) {
    const run = session.run;
    if (!run) throw new Error("There is no active turn to stop.");
    if (this.demo) {
      clearTimeout(run.demoTimer);
      this.finish(session, false, "The turn was stopped.", true);
      return;
    }
    if (!run.turn || !session.threadId) throw new Error("Wait for Codex to acknowledge the turn before stopping it.");
    await this.server!.call("turn/interrupt", { threadId: session.threadId, turnId: run.turn.id });
  }

  private async steer(session: AgentSession, text: string) {
    if (!session.agent.canSteer) throw new Error("There is no active turn to steer.");
    if (session.agent.directTask && session.run) session.run.steered = true;
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
    const directTaskRun = session.run?.taskImplementation ? session.run : undefined;
    if (session.run && !completed) {
      const answer = session.run.message;
      answer.state = cancelled ? "cancelled" : "failed";
      if (!session.recovery) this.reopenProductQuestion(session, answer);
    }
    delete session.run;
    if (session.agent.canCancel !== undefined) session.agent.canCancel = false;
    for (const entry of session.stream.values()) {
      if (completed) delete entry.state;
      else entry.state = cancelled ? "cancelled" : "failed";
    }
    session.stream.clear();
    session.agent.status = completed ? "done" : cancelled ? "idle" : "error";
    if (directTaskRun) {
      completed = this.finishDirectTask(session, directTaskRun.check,
        completed ? undefined : detail ?? "The implementation turn did not complete.");
      if (!completed && !cancelled) directTaskRun.message.state = "failed";
    } else if (session.agent.directTask?.phase === "ready-for-review") {
      session.agent.status = "awaiting-confirmation";
    } else if (session.agent.directTask?.phase === "blocked") {
      session.agent.status = "error";
    }
    if (detail) session.agent.messages.push(message("system", detail, completed || cancelled ? "notice" : "error"));
    if (!completed || !this.drain(session)) this.update(session);
    return completed;
  }

  private drain(session: AgentSession) {
    if (!this.isActive(session) || !this.available || session.run || session.agent.queuePaused ||
        session.agent.unavailableReason || (!this.demo && !session.threadId) || !session.queue.length) return false;
    void this.begin(session, session.queue.shift()!);
    return true;
  }

  private async resumeNativeChild(session: AgentSession) {
    const threadId = session.threadId;
    const parent = session.agent.parentId ? this.sessions.get(session.agent.parentId) : undefined;
    if (!threadId || !parent?.threadId) return;
    try {
      const { thread } = await this.server!.call<{ thread: Thread & {
        parentThreadId?: string; status?: { type: string };
        turns?: (Turn & { items?: { id: string; type: string; text?: string }[] })[];
      } }>("thread/read", { threadId, includeTurns: true });
      if (thread.id !== threadId || thread.parentThreadId !== parent.threadId) {
        throw new Error("Codex reported a different parent for this subagent.");
      }
      this.threadSessions.set(threadId, session);
      this.trackUsage((usage) => usage.registerThread(threadId, false, session.agent.id));
      for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
          if (item.type === "agentMessage" && typeof item.text === "string") this.recordNativeReply(session, item.id, item.text);
        }
      }
      if (thread.status?.type === "active") session.agent.status = "working";
      else if (session.agent.status === "working") {
        const last = thread.turns?.at(-1);
        session.agent.status = last?.status === "completed" ? "done" : "idle";
      }
      delete session.agent.unavailableReason;
    } catch (error) {
      session.agent.unavailableReason = errorText(error);
      if (session.agent.status === "working") session.agent.status = "error";
    }
  }

  private recordNativeReply(session: AgentSession, itemId: string | undefined, text: string) {
    const existing = itemId && session.agent.messages.find((entry) => entry.providerItemId === itemId);
    if (existing) {
      existing.text = text;
      delete existing.state;
      session.stream.delete(itemId);
    } else {
      session.agent.messages.push({ ...message("assistant", text), providerItemId: itemId });
    }
  }

  private registerNativeChild(parent: AgentSession, threadId: string, name?: string | null, model?: string | null, role?: string | null) {
    if (!threadId || threadId.length > 200) return;
    let child = this.threadSessions.get(threadId);
    if (child && (!child.agent.nativeChild || child.agent.parentId !== parent.agent.id)) return;
    if (!child) {
      const id = `native:${threadId}`;
      if (this.sessions.has(id)) return;
      child = this.createAgent(id, name || "Codex subagent", "worker", parent.agent.id);
      Object.assign(child.agent, { nativeChild: true, projectId: parent.agent.projectId, status: "working" });
      child.threadId = threadId;
      this.threadSessions.set(threadId, child);
      this.trackUsage((usage) => usage.registerThread(threadId, true, id));
    }
    if (name) child.agent.name = name;
    if (model) child.agent.modelSettings = { reportedModel: model, source: "provider-default" };
    if (role === "lead" || role === "coder" || role === "reviewer" || role === "tester" || role === "designer" || role === "analyser" || role === "pm") {
      child.agent.duty = role;
    }
    return child;
  }

  private recordNativeActivity(parent: AgentSession, item: NonNullable<Event["params"]["item"]>, completed: boolean) {
    if (!item.agentThreadId || !["started", "interacted", "interrupted", "completed"].includes(item.kind ?? "")) return;
    const child = this.registerNativeChild(parent, item.agentThreadId, item.agentNickname, item.model, item.agentRole);
    if (!child) return;
    if (item.agentPath && child.agent.name === "Codex subagent") child.agent.name = item.agentPath;
    if (item.kind === "interrupted") child.agent.status = "idle";
    else if (item.kind === "completed" && child.agent.status !== "error") child.agent.status = "done";
    if (completed && (item.kind === "completed" || item.kind === "interrupted")) this.signal(child.agent.id, parent.agent.id);
    this.publish();
  }

  private onNativeEvent(session: AgentSession, method: string, params: Event["params"]) {
    if (session.agent.archivedAt) return;
    if (method === "turn/started" || method === "turn/completed" || method === "thread/tokenUsage/updated") {
      const turnId = params.turn?.id ?? params.turnId;
      if (turnId && session.threadId) {
        let owner = this.sessions.get(session.agent.parentId!);
        while (owner?.agent.nativeChild) owner = this.sessions.get(owner.agent.parentId!);
        const entry = owner?.run?.message;
        this.trackUsage((usage) => usage.registerTurn(session.threadId!, turnId, {
          agentId: session.agent.id, runId: entry?.orchestrationRunId ?? entry?.id ?? turnId,
          model: session.agent.modelSettings?.reportedModel,
        }));
      }
      if (method === "thread/tokenUsage/updated") return;
      session.agent.status = method === "turn/started" ? "working"
        : params.turn?.status === "completed" ? "done" : params.turn?.status === "interrupted" ? "idle" : "error";
      if (method === "turn/completed") {
        for (const entry of session.stream.values()) {
          if (session.agent.status === "done") delete entry.state;
          else entry.state = "failed";
        }
        session.stream.clear();
      }
      this.publish();
    }
    if (method === "error" && !params.willRetry) {
      session.agent.status = "error";
      session.agent.messages.push(message("system", errorText(params.error?.message ?? params.message ?? "Codex subagent reported an error."), "error"));
      this.publish();
      return;
    }
    const item = params.item;
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
    } else if (method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
      this.recordNativeReply(session, item.id, item.text);
      this.publish();
    }
  }

  private onEvent({ method, params }: Event) {
    const session = params.threadId ? this.threadSessions.get(params.threadId) : undefined;
    const startedThread = method === "thread/started" ? params.thread : undefined;
    if (startedThread?.parentThreadId) {
      const parent = this.threadSessions.get(startedThread.parentThreadId);
      if (parent && !parent.agent.archivedAt && (parent.agent.directTask || parent.agent.nativeChild)) {
        this.registerNativeChild(parent, startedThread.id, startedThread.agentNickname, undefined, startedThread.agentRole);
        this.publish();
      }
    }
    if (session && !session.agent.archivedAt && (session.agent.directTask || session.agent.nativeChild) &&
        (method === "item/started" || method === "item/completed") && params.item?.type === "subAgentActivity") {
      this.recordNativeActivity(session, params.item, method === "item/completed");
      return;
    }
    if (session?.agent.nativeChild) {
      this.onNativeEvent(session, method, params);
      if (method !== "thread/tokenUsage/updated") return;
    }
    if (method === "thread/tokenUsage/updated") {
      const { threadId, turnId, tokenUsage } = params;
      if (threadId && turnId) {
        this.trackUsage((usage) => usage.observe(threadId, turnId, tokenUsage));
        this.publish(false);
      }
      return;
    }
    if (method === "error") {
      const detail = errorText(params.error?.message ?? params.message ?? "Codex reported an error.");
      if (/usage.?limit|rate.?limit|quota/i.test(detail)) {
        this.setProvider("usage-limit", detail);
        for (const session of this.sessions.values()) session.agent.canSteer = false;
      } else if (params.willRetry && /reconnect/i.test(detail)) {
        this.setProvider("connecting", detail);
        for (const session of this.sessions.values()) session.agent.canSteer = false;
      }
      this.publish();
      return;
    }
    if (!session?.run) return;
    if ((method === "turn/started" || method === "turn/completed") && params.threadId && params.turn &&
        (!session.run.turn || session.run.turn.id === params.turn.id)) {
      this.trackTurn(session, params.threadId, params.turn.id, session.run.message);
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
      if (cancelled) session.agent.queuePaused = session.queue.length > 0;
      const detail = params.turn.error?.message ?? (cancelled ? "The turn was interrupted." : "The turn did not complete.");
      this.finish(session, completed, completed ? undefined : errorText(detail), cancelled);
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
    const run = session?.run;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.server!.reply(id, { decision: "decline" });
      if (session && this.isActive(session)) {
        session.agent.messages.push(message("system", "Orchestra declined a permission request outside the task's write scope.", "warning"));
        this.publish();
      }
      return;
    }
    if (method !== "item/tool/call") {
      this.server!.reject(id, "This request is not supported by the workspace.");
      return;
    }
    const reply = (success: boolean, text: string) => this.server!.reply(id, { success, contentItems: [{ type: "inputText", text }] });
    if (!session?.agent.directTask || !this.isActive(session) || !run?.turn || run.turn.id !== params.turnId || params.namespace != null) {
      reply(false, "This tool is unavailable for the current turn.");
      return;
    }
    try {
      if (params.tool === resolveQuestionTool.name) {
        this.resolveProductQuestion(session, params.arguments?.questionId);
        reply(true, "Question marked answered.");
        return;
      }
      if (params.tool === decisionTool.name) {
        const question = typeof params.arguments?.question === "string" ? params.arguments.question.trim() : "";
        if (!question || question.length > 4000) throw new Error("Provide a product question of up to 4,000 characters.");
        if (session.toolVersion !== taskToolVersion && question.startsWith(legacyQuestionResolutionPrefix)) {
          this.resolveProductQuestion(session, question.slice(legacyQuestionResolutionPrefix.length).trim());
          reply(true, "Question marked answered.");
          return;
        }
        const questionMessage: WorkspaceMessage = {
          ...message("system", `Product decision from ${session.agent.name}: ${question}`, "action"),
          productQuestion: { status: "pending" },
        };
        session.agent.messages.push(questionMessage);
        if (!this.persist()) {
          session.agent.messages.pop();
          this.publish(false);
          throw new Error("Orchestra could not save the product question.");
        }
        this.publish(false);
        reply(true, JSON.stringify({ questionId: questionMessage.id,
          message: "End this turn so the user can answer the question." }));
        return;
      }
      if (params.tool === checkTool.name) {
        const outcome = params.arguments?.outcome;
        const summary = typeof params.arguments?.summary === "string" ? params.arguments.summary.trim() : "";
        if ((outcome !== "passed" && outcome !== "changes-requested" && outcome !== "blocked") || !summary || summary.length > 2400) {
          throw new Error("Provide a check outcome and a summary of up to 2,400 characters.");
        }
        if (!run.taskImplementation) throw new Error("Checks can be submitted only during approved implementation.");
        run.check = { outcome, summary, submissionId: run.turn.id,
          candidateFingerprint: fingerprintIntegrationMembers(this.directTaskCandidates(session)) };
        reply(true, "Check result recorded.");
        return;
      }
      reply(false, "Unknown workspace tool.");
    } catch (error) {
      reply(false, errorText(error));
    }
  }

  private scheduleDemo(session: AgentSession, run: Run) {
    if (run.demoTimer) return;
    run.demoTimer = setTimeout(() => {
      if (this.closed || session.run !== run) return;
      session.agent.messages.push(message("assistant", "Demo received your message. This turn is complete."));
      this.finish(session, true);
    }, 900);
  }

  private seedDemo() {
    const task = this.createAgent("demo-release", "Release notes", "worker", undefined, "Draft the release notes");
    task.agent.directTask = { projectIds: [], phase: "planning" };
    task.agent.status = "done";
    task.agent.messages.push(
      message("user", "Draft a release note for the workspace updates."),
      message("assistant", "The draft is ready. It highlights task sessions, native subagents, and the workspace inbox."),
      { ...message("system", "Should the release note be terse or detailed?", "action"),
        productQuestion: { status: "pending" } },
    );
    const child = this.createAgent("demo-review", "Check the draft", "worker", task.agent.id);
    child.agent.nativeChild = true;
    child.agent.duty = "reviewer";
    child.agent.status = "done";
    child.agent.messages.push(message("assistant", "The draft covers all three workspace changes."));
    const solo = this.createAgent("demo-recipe", "Weeknight dinner", "worker");
    solo.agent.directTask = { projectIds: [], phase: "planning" };
    solo.agent.status = "done";
    solo.agent.messages.push(message("assistant", "Try lemon chickpeas with roasted vegetables."));
  }

}
