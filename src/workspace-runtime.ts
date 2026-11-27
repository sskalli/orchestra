import { acquirePathReservations, checkoutReservationDirectory, reservationOwnerAlive,
  releasePathReservations, type CheckoutReservation } from "./workspace-reservations.ts";
import { demoTasks } from "./workspace-demo.ts";
import { WorkspaceUsage } from "./workspace-usage.ts";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { AppServer, codexCommand, safeError, type ProviderServer } from "./app-server.ts";
import { ClaudeAppServer, claudeProviderId } from "./claude-app-server.ts";
import type { Event, Id, Thread, Turn } from "./app-server.ts";
import { createFeatureWorktree, removeFeatureWorktree } from "./workspace-worktree.ts";
import { fingerprintCandidate, fingerprintCheckout, fingerprintMemberSnapshots, hasWorktreeChanges, pinApprovedCandidate, pinDirectCandidates, validateCandidateWorktree, type IntegrationMember } from "./workspace-integration.ts";
import { recordReportedModel, selectModelSettings } from "./workspace-models.ts";
import type { ModelSettings, ReportedModel } from "./workspace-models.ts";
import type { SavedSession, workspaceStore } from "./workspace-store.ts";
import { checkoutBaseline, createRequestedWorktree, removeRequestedWorktree, resolveWriteTargets, validateRequestedWorktree } from "./workspace-write-scope.ts";
import type { WriteTarget } from "./workspace-write-scope.ts";
import { defaultProject, workspaceIdentity } from "./workspace-projects.ts";
import type { WorkspaceProject } from "./workspace-projects.ts";
import { implementationApprovalText, messageLength, messageLengthProblem } from "./workspace-chat-recovery.ts";

export type AgentStatus = "idle" | "working" | "attention" | "awaiting-confirmation" | "done" | "error" | "notice";
export type AgentRole = "worker";
export type SystemMessageKind = "error" | "action" | "warning" | "notice" | "success";
export type WorkspaceMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt?: number;
  kind?: SystemMessageKind;
  providerItemId?: string;
  state?: "queued" | "streaming" | "failed" | "cancelled";
  productQuestion?: { status: "pending" } | { status: "answered"; answerMessageId: string };
  answersProductQuestionId?: string;
  commandApproval?: PermissionApproval;
  implementationRequest?: { status: "pending" | "approved" | "superseded"; targets?: WriteTarget[] };
};
export type ApprovalChoice = "approve" | "approveForSession" | "decline";
/** A native Codex permission request. Saved entries without a kind are command approvals. */
export type PermissionApproval = {
  status: "pending" | "approved" | "approved-for-session" | "declined" | "expired" | "unconfirmed";
  kind?: "command" | "fileChange" | "permissions";
  command?: string;
  cwd?: string;
  reason?: string;
  files?: string[];
  writePaths?: string[];
  readPaths?: string[];
  network?: string;
  choices?: ApprovalChoice[];
  declineStopsTurn?: boolean;
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
  scopedWorktrees?: WorktreeRoot[];
  integration?: { id: string; path: string; base: string; fingerprint: string; sources: { agentId: string; submissionId: string; head: string; fingerprint?: string; projectId?: string }[]; members?: IntegrationMember[]; validationEvidence?: CheckResult };
  status: AgentStatus;
  messages: WorkspaceMessage[];
  queueDepth: number;
  queuePaused?: boolean;
  unavailableReason?: string;
  canSteer: boolean;
  canCancel?: boolean;
  /** The agent ended its response and its turn stays open for this many background subagents. */
  awaitingSubagents?: number;
  /** The provider is retrying this task's current turn, for example after a dropped stream. */
  reconnecting?: string;
  archivedAt?: number;
  lifecycleBusy?: boolean;
  lifecycleBlockedReason?: string;
};
export type WorkspaceProvider = "codex" | "claude";
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
  | { type: "resolveCommandApproval"; agentId: string; requestId: string; decision: ApprovalChoice }
  | { type: "approveImplementation"; agentId: string; requestId: string }
  | { type: "send" | "steer"; agentId: string; text: string }
  | { type: "resumeQueue" | "cancel" | "restore" | "delete"; agentId: string }
  | { type: "rename"; agentId: string; name: string }
  | { type: "archive"; agentId: string; stopRunning?: boolean };

type Candidate = { path: string; base: string };
type WorktreeRoot = Candidate & (
  { projectId: string; mode: "automatic"; branch?: never } | Extract<WriteTarget, { mode: "worktree" }>
);
type ImplementationRoot = WorktreeRoot | (Candidate & { projectId: string; mode: "checkout" });
type CheckResult = { submissionId: string; candidateFingerprint: string;
  outcome: "passed" | "changes-requested" | "blocked"; summary: string; recordedAt: number };
type Duty = "lead" | "coder" | "reviewer" | "tester" | "analyser" | "designer" | "pm";

type Run = {
  implementationRoots?: ImplementationRoot[];
  steered?: boolean;
  turn?: Turn;
  message: WorkspaceMessage;
  check?: CheckResult;
  commandApprovals?: Map<Id, { message: WorkspaceMessage; responses: ApprovalResponses }>;
  fileChanges?: Map<string, string[]>;
  interrupting?: boolean;
  /** Background subagents the provider is still running after the agent ended its response. */
  awaitingSubagents?: number;
  demoTimer?: ReturnType<typeof setTimeout>;
};
type ApprovalResponses = { approve?: object; approveForSession?: object; decline: object };
type ApprovalOffer = { view: Omit<PermissionApproval, "status">; responses: ApprovalResponses };
type AgentSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  freshThread?: boolean;
  toolVersion?: number;
  run?: Run;
  recovery?: SavedSession["run"];
  checkoutReservation?: CheckoutReservation;
  opening?: boolean;
  queue: WorkspaceMessage[];
  stream: Map<string, WorkspaceMessage>;
};

const questionResolutionToolVersion = 14;
const implementationRequestToolVersion = 15;
const taskToolVersion = 16;
const legacyScopedImplementationPrefix = "Request implementation targets: ";
const legacyImplementationRequestPrefix = "Request implementation: ";
const legacyQuestionResolutionPrefix = "Resolve product question: ";
const unresolvedSubagentPrefix = "Subagent activity is unresolved. ";
const legacyUnresolvedSubagentPrefix = "Codex subagent activity is unresolved. ";
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
const implementationRequestTool = {
  type: "function",
  deferLoading: false,
  name: "request_implementation",
  description: "Summarize the intended changes and ask for write approval. Use automatic isolated worktrees unless the user explicitly asks for a configured checkout or a new worktree at a specific absolute path. End the turn to wait for approval.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      targets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            mode: { type: "string", enum: ["checkout", "worktree"] },
            path: { type: "string" },
            branch: { type: "string" },
          },
          required: ["projectId", "mode"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary"], additionalProperties: false,
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

function message(role: WorkspaceMessage["role"], text: string, kind?: SystemMessageKind, createdAt: number | null = Date.now()): WorkspaceMessage {
  return { id: randomUUID(), role, text, ...(createdAt === null ? {} : { createdAt }), ...(kind ? { kind } : {}) };
}

function errorText(error: unknown) {
  return safeError(error instanceof Error ? error.message : error);
}

/**
 * Recognizes rate and usage limits. Codex reports an HTTP 429 from a provider as
 * "exceeded retry limit, last status: 429 Too Many Requests" with structured codexErrorInfo.
 */
function limitDetail(engineName: string, detail: string, error: unknown) {
  const info = (error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo;
  const structured = info === "usageLimitExceeded" || (!!info && typeof info === "object" &&
    Object.entries(info).some(([kind, value]) => kind === "usageLimitExceeded" ||
      (value as { httpStatusCode?: unknown } | null)?.httpStatusCode === 429));
  const phrase = /\b(usage|rate) limit\b|too many requests|insufficient_quota|exceeded your current quota|last status: 429\b/i;
  if (!structured && !phrase.test(detail)) return undefined;
  if (/\b(usage|rate) limit\b/i.test(detail)) return detail;
  return `${engineName} hit a rate or usage limit. ${detail}`;
}

// Characters that can hide or reorder what the user reviews on an approval card.
const unsafeDisplayText = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

function commandDecline(params: Event["params"]) {
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
  // "cancel" also interrupts the turn, so prefer "decline" whenever Codex offers it.
  const stopsTurn = !!decisions && !decisions.includes("decline");
  return { response: { decision: stopsTurn ? "cancel" : "decline" }, stopsTurn };
}

/** Lists requested paths for review. Incomplete means the card could not show everything an approval would grant. */
function permissionPaths(raw: unknown) {
  const profile = raw && typeof raw === "object" ? raw as Record<string, any> : {};
  const fileSystem = profile.fileSystem && typeof profile.fileSystem === "object" ? profile.fileSystem : {};
  let complete = true;
  const special = (value: any) => {
    const kind = typeof value === "string" ? value : value?.kind;
    if (typeof kind !== "string") return undefined;
    const detail = typeof value?.subpath === "string" ? value.subpath : typeof value?.path === "string" ? value.path : undefined;
    return detail ? `[${kind}] ${detail}` : `[${kind}]`;
  };
  const display = (path: any) => typeof path === "string" ? path
    : path?.type === "path" && typeof path.path === "string" ? path.path
    : path?.type === "glob_pattern" && typeof path.pattern === "string" ? path.pattern
    : path?.type === "special" ? special(path.value) : undefined;
  const collect = (legacy: unknown, access: string) => {
    const entries = [
      ...(Array.isArray(legacy) ? legacy : []),
      ...(Array.isArray(fileSystem.entries) ? fileSystem.entries.filter((entry: any) => entry?.access === access).map((entry: any) => entry.path) : []),
    ].map(display);
    if (entries.some((path) => !path || unsafeDisplayText.test(path)) || entries.length > 100) complete = false;
    return [...new Set(entries.filter((path): path is string => !!path))].slice(0, 100);
  };
  const writePaths = collect(fileSystem.write, "write");
  const readPaths = collect(fileSystem.read, "read");
  if (Array.isArray(fileSystem.entries) && fileSystem.entries.some((entry: any) => !["read", "write", "deny"].includes(entry?.access))) complete = false;
  return {
    complete,
    paths: { ...(writePaths.length ? { writePaths } : {}), ...(readPaths.length ? { readPaths } : {}) },
    network: profile.network?.enabled === true,
  };
}

function networkHost(context: unknown) {
  const host = (context as { host?: unknown } | null | undefined)?.host;
  return typeof host === "string" && host && !unsafeDisplayText.test(host) ? host : undefined;
}

function approvalSummary(kind: NonNullable<PermissionApproval["kind"]>) {
  return kind === "fileChange" ? "Permission requested to change files."
    : kind === "permissions" ? "Permission requested for additional access."
    : "Permission requested to run a command outside the sandbox.";
}

export class WorkspaceRuntime {
  private readonly state: WorkspaceSnapshot;
  private readonly demo: boolean;
  private readonly providerId: string;
  private readonly projects: WorkspaceProject[];
  private readonly store?: ReturnType<typeof workspaceStore>;
  private storageFailed = false;
  private releaseWorkspaceState?: () => void;
  private storageReady = false;
  /** The turn whose provider error reported the current usage limit. */
  private limitTurnId?: string;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly threadSessions = new Map<string, AgentSession>();
  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private readonly signalListeners = new Set<(signal: AgentSignal) => void>();
  private server?: ProviderServer;
  private readonly engine: WorkspaceProvider;
  private readonly engineName: string;
  private usage?: WorkspaceUsage;
  private usageIssue?: string;
  private started = false;
  private closed = false;

  private readonly createServer?: () => ProviderServer;

  constructor({ cwd, projects = [defaultProject(cwd)], demo = false, modelProvider = "openai", engine = "codex", store, createServer }: {
    cwd: string;
    projects?: WorkspaceProject[];
    demo?: boolean;
    modelProvider?: string;
    engine?: WorkspaceProvider;
    /** Replaces the provider connection, for tests. */
    createServer?: () => ProviderServer;
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
    this.engine = engine;
    this.createServer = createServer;
    this.engineName = engine === "claude" ? "Claude" : "Codex";
    this.providerId = engine === "claude" ? claudeProviderId : modelProvider;
    this.store = demo ? undefined : store;
    this.state = {
      project: { name: this.projects.length === 1 ? basename(path) : "Workspace", path },
      projects: this.projects,
      workspaceKey: workspaceIdentity(this.projects),
      modelProvider,
      provider: { name: engine, state: demo ? "demo" : "connecting" },
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
      runId: entry.id,
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
      this.releaseWorkspaceState = this.store?.reserveProcess?.();
      saved = this.store?.load();
      if (saved) this.restore(saved);
      this.storageReady = true;
    } catch (error) {
      this.releaseWorkspaceState?.();
      delete this.releaseWorkspaceState;
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
    const server: ProviderServer = this.createServer?.() ?? (this.engine === "claude"
      ? new ClaudeAppServer(this.store?.claudeJournalPath)
      : new AppServer(this.state.project.path));
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
          this.setProvider("signed-out", `Sign in to ${this.engineName} with ChatGPT: run \`${codexCommand()} login\`, then restart the workspace.`);
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
      if (!this.storageFailed && !this.closed) {
        if (this.state.provider.state !== "usage-limit") this.setProvider("ready");
        this.releaseSettledCheckouts();
      }
    } catch (error) {
      this.setProvider("error", errorText(error));
    }
    this.publish();
  }

  async close() {
    for (const session of this.sessions.values()) this.expireCommandApprovals(session.run);
    this.persist();
    this.closed = true;
    for (const session of this.sessions.values()) clearTimeout(session.run?.demoTimer);
    this.listeners.clear();
    this.signalListeners.clear();
    try {
      await this.server?.close();
    } finally {
      this.releaseWorkspaceState?.();
      delete this.releaseWorkspaceState;
    }
  }

  async command(command: WorkspaceCommand) {
    if (this.closed) throw new Error("The workspace is closed.");
    if (command.type === "createTask") return this.createDirectTask(command.name, command.projectIds);
    const session = this.sessions.get(command.agentId);
    if (!session) throw new Error("This conversation no longer exists.");
    if (session.agent.nativeChild) throw new Error(`Use the owning task to interact with this ${this.engineName} subagent.`);
    if (command.type === "rename") {
      this.renameTask(session, command.name);
      return;
    }
    if (command.type === "archive" || command.type === "restore" || command.type === "delete") {
      await this.lifecycle(session, command);
      return;
    }
    if (!this.isActive(session)) throw new Error("Restore this archived conversation before messaging it.");
    if (command.type === "resolveCommandApproval") {
      this.resolveCommandApproval(session, command.requestId, command.decision);
      return;
    }
    if (command.type === "approveImplementation") {
      const request = session.agent.messages.find(({ id }) => id === command.requestId);
      if (request?.implementationRequest?.status !== "pending") {
        throw new Error("This implementation request is no longer pending.");
      }
      await this.startDirectTaskImplementation(session, request);
      return;
    }
    if (command.type === "cancel") {
      await this.interrupt(session);
      return;
    }
    if (!this.available || session.agent.unavailableReason) {
      throw new Error(session.agent.unavailableReason ?? this.state.provider.message ?? "The provider is unavailable.");
    }
    if (!this.demo && !session.threadId) throw new Error(`This ${this.engineName} conversation is still opening or failed to open.`);
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
    if (!text) throw new Error("Enter a message.");
    const question = command.type === "answerProductQuestion"
      ? session.agent.messages.find(({ id }) => id === command.questionId) : undefined;
    const tooLong = messageLengthProblem(text, question ? messageLength(this.answerPrefix(question.text)) : 0);
    if (tooLong) throw new Error(tooLong);
    if (command.type === "steer") {
      await this.steer(session, text);
      return;
    }
    if (command.type === "answerProductQuestion") {
      await this.answerProductQuestion(session, command.questionId, text);
      return;
    }
    this.supersedeImplementationRequest(session);
    const next = message("user", text);
    session.agent.messages.push(next);
    await this.enqueue(session, next);
  }

  private supersedeImplementationRequest(session: AgentSession) {
    const request = session.agent.messages.find((entry) => entry.implementationRequest?.status === "pending");
    if (request?.implementationRequest) request.implementationRequest.status = "superseded";
    return request;
  }

  private async answerProductQuestion(session: AgentSession, questionId: string, text: string) {
    const question = session.agent.directTask
      ? session.agent.messages.find((entry) => entry.id === questionId)
      : undefined;
    if (question?.productQuestion?.status !== "pending") {
      throw new Error("This product question is no longer awaiting an answer in this task.");
    }
    const superseded = this.supersedeImplementationRequest(session);
    const answer = { ...message("user", text), answersProductQuestionId: question.id, state: "queued" as const };
    question.productQuestion = { status: "answered", answerMessageId: answer.id };
    session.agent.messages.push(answer);
    const live = this.acceptsLiveMessages(session);
    if (!live) session.queue.push(answer);
    if (!this.persist()) {
      if (!live) session.queue.pop();
      session.agent.messages.pop();
      if (superseded?.implementationRequest) superseded.implementationRequest.status = "pending";
      question.productQuestion = { status: "pending" };
      this.publish(false);
      throw new Error("Orchestra could not save the answer. The question remains pending.");
    }
    if (live) {
      if (await this.deliverToWaitingTurn(session, answer, this.answerInput(session, answer))) return;
      session.queue.push(answer);
    }
    if (!this.drain(session)) this.update(session);
  }

  /** A turn kept open only for background subagents takes new messages now instead of queueing them behind the subagents. */
  private acceptsLiveMessages(session: AgentSession) {
    return Boolean(!this.demo && session.run?.turn && session.run.awaitingSubagents && session.agent.canSteer &&
      !session.agent.queuePaused && !session.queue.length);
  }

  private async deliverToWaitingTurn(session: AgentSession, entry: WorkspaceMessage, text: string) {
    const run = session.run;
    if (!run?.turn || !this.acceptsLiveMessages(session)) return false;
    try {
      await this.server!.call("turn/steer", { threadId: session.threadId, expectedTurnId: run.turn.id, input: input(text) });
    } catch {
      return false;
    }
    if (session.agent.directTask) run.steered = true;
    delete entry.state;
    this.update(session);
    return true;
  }

  private taskName(name: string) {
    const title = typeof name === "string" ? name.trim() : "";
    if (!title || title.length > 60) throw new Error("Provide a task name of up to 60 characters.");
    return title;
  }

  private renameTask({ agent }: AgentSession, name: string) {
    if (agent.lifecycleBusy) throw new Error("Wait for the current task action to finish before renaming.");
    const title = this.taskName(name);
    const previousName = agent.name;
    if (title === previousName) return;
    agent.name = title;
    if (!this.persist()) {
      agent.name = previousName;
      this.publish(false);
      throw new Error("Orchestra could not save the task name.");
    }
    this.publish(false);
  }

  private async createDirectTask(name: string, projectIds: string[]) {
    if (!this.available || this.demo || this.storageFailed) {
      throw new Error(`${this.engineName} must be ready to create a task.`);
    }
    const title = this.taskName(name);
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

  private async startDirectTaskImplementation(session: AgentSession, request: WorkspaceMessage) {
    const task = session.agent.directTask;
    if (!task?.projectIds.length) throw new Error("Choose at least one repository for an implementation task.");
    if (!this.available || this.storageFailed || !session.threadId || session.agent.unavailableReason) {
      throw new Error(`This ${this.engineName} task is unavailable.`);
    }
    if (session.run || session.opening || session.recovery || session.queue.length ||
        task.phase === "implementing") {
      throw new Error("Wait for the task to finish its current turn before approving implementation.");
    }
    if (this.hasRunningNativeChildren(session)) {
      throw new Error(`Wait for this task's ${this.engineName} subagents to finish before approving implementation.`);
    }
    if (session.agent.messages.some((entry) => entry.productQuestion?.status === "pending")) {
      throw new Error("Answer the pending product questions before approving implementation.");
    }
    this.releaseSettledCheckouts(session);
    if (session.checkoutReservation) {
      throw new Error("The previous checkout reservation could not be released. Recover its workspace before approving another edit.");
    }
    const agent = session.agent;
    const approval = request.implementationRequest;
    if (approval?.status !== "pending") throw new Error("This implementation request is no longer pending.");
    const targets = resolveWriteTargets(approval.targets, this.projects, task.projectIds);
    if (JSON.stringify(targets) !== JSON.stringify(approval.targets ?? [])) {
      throw new Error("An approved destination changed. Request approval for the new location.");
    }
    const checkoutDirectories = [...new Set(targets.filter(({ mode }) => mode === "checkout")
      .map(({ projectId }) => checkoutReservationDirectory(this.projectById(projectId).path)))].sort();
    const { roots, created } = this.prepareImplementationRoots(session, targets);
    if (this.hasOverlappingImplementation(session, roots)) {
      this.removePreparedWorktrees(created);
      throw new Error("Another task is already writing in an approved destination. Wait for it to finish.");
    }
    if (messageLengthProblem(this.implementationInput(implementationApprovalText, request.text, roots))) {
      this.removePreparedWorktrees(created);
      throw new Error(`The implementation request is too long to send to ${this.engineName}. Ask the agent for a shorter request.`);
    }

    const previousWorktrees = agent.scopedWorktrees;
    const previousCandidate = agent.candidate;
    const previousDirectCandidates = agent.directCandidates;
    const previousTask = { ...task };
    const previousStatus = agent.status;
    const previousIntegration = agent.integration;
    const assignment = message("user", implementationApprovalText);
    const reservation = checkoutDirectories.length
      ? { id: assignment.id, pid: process.pid, directories: checkoutDirectories } : undefined;
    const automatic = roots.every(({ mode }) => mode === "automatic");
    if (automatic && !agent.candidate) {
      const [candidate] = roots;
      agent.candidate = { path: candidate.path, base: candidate.base };
      if (roots.length > 1) agent.directCandidates = roots.map(({ projectId, path, base }) => ({ projectId, path, base }));
    } else if (created.length) {
      agent.scopedWorktrees = [...(agent.scopedWorktrees ?? []), ...created];
    }
    approval.status = "approved";
    task.phase = "implementing";
    delete task.detail;
    delete agent.integration;
    agent.messages.push(assignment);
    await this.begin(session, assignment, { roots, summary: request.text, reservation }, () => {
      agent.scopedWorktrees = previousWorktrees;
      agent.candidate = previousCandidate;
      agent.directCandidates = previousDirectCandidates;
      agent.directTask = previousTask;
      agent.status = previousStatus;
      agent.integration = previousIntegration;
      agent.messages.pop();
      approval.status = "pending";
      this.removePreparedWorktrees(created);
    });
  }

  private prepareImplementationRoots(session: AgentSession, targets: WriteTarget[]) {
    const scoped = session.agent.scopedWorktrees ?? [];
    const automatic = this.directTaskCandidates(session);
    const created: WorktreeRoot[] = [];
    try {
      const roots: ImplementationRoot[] = session.agent.directTask!.projectIds.map((projectId) => {
        const project = this.projectById(projectId);
        const target = targets.find((entry) => entry.projectId === projectId);
        if (target?.mode === "checkout") {
          return { projectId, mode: "checkout", path: project.path, base: checkoutBaseline(project.path) };
        }
        if (target?.mode === "worktree") {
          const previous = scoped.find((entry) => entry.projectId === projectId && entry.mode === "worktree" &&
            entry.path === target.path && entry.branch === target.branch);
          if (previous) {
            validateRequestedWorktree(project.path, target, previous);
            return previous;
          }
          const next: WorktreeRoot = { ...createRequestedWorktree(project.path, target), ...target };
          created.push(next);
          return next;
        }

        const previous = automatic.find((entry) => entry.projectId === projectId) ??
          scoped.find((entry) => entry.projectId === projectId && entry.mode === "automatic");
        if (previous) {
          if (realpathSync(previous.path) !== previous.path) throw new Error("An isolated worktree location changed.");
          validateCandidateWorktree(project.path, previous);
          return { ...previous, mode: "automatic" };
        }
        const next: WorktreeRoot = { ...createFeatureWorktree(project.path), projectId, mode: "automatic" };
        created.push(next);
        return next;
      });
      return { roots, created };
    } catch (error) {
      this.removePreparedWorktrees(created);
      throw error;
    }
  }

  private removePreparedWorktrees(created: WorktreeRoot[]) {
    for (const { path, projectId, branch, base, mode } of [...created].reverse()) {
      const project = this.projectById(projectId).path;
      if (mode === "worktree") removeRequestedWorktree(project, path, branch, base);
      else removeFeatureWorktree(project, path);
    }
  }

  private directTaskCandidates(session: AgentSession) {
    const { candidate, directCandidates, projectId } = session.agent;
    return directCandidates ?? (candidate && projectId ? [{ ...candidate, projectId }] : []);
  }

  private hasOverlappingImplementation(session: AgentSession, roots: ImplementationRoot[]) {
    const contains = (parent: string, path: string) => {
      const offset = relative(parent, path);
      return offset !== ".." && !offset.startsWith(".." + sep) && !isAbsolute(offset);
    };
    return [...this.sessions.values()].some((other) => other !== session && this.activeWritePaths(other).some(
      (path) => roots.some((root) => contains(root.path, path) || contains(path, root.path)),
    ));
  }

  private releaseSettledCheckouts(session?: AgentSession) {
    for (const owner of session ? [session] : this.sessions.values()) {
      const reservation = owner.checkoutReservation;
      if (!reservation || owner.run || owner.recovery || owner.agent.unavailableReason ||
          this.hasRunningNativeChildren(owner)) continue;
      if (reservation.pid !== process.pid && reservationOwnerAlive(reservation)) continue;
      if (releasePathReservations(reservation)) delete owner.checkoutReservation;
    }
  }

  private activeWritePaths(session: AgentSession) {
    if (session.run?.implementationRoots) return session.run.implementationRoots.map(({ path }) => path);
    const { agent } = session;
    if (!agent.directTask || agent.directTask.phase !== "blocked") return [];
    const unresolved = session.recovery || /active (?:writer|turn)|still be running|unresolved|not acknowledged/i.test(agent.unavailableReason ?? "");
    if (!unresolved && !this.hasRunningNativeChildren(session)) return [];
    const approval = agent.messages.findLast((entry) => entry.implementationRequest?.status === "approved");
    const targets = approval?.implementationRequest?.targets ?? [];
    const candidates = this.directTaskCandidates(session);
    return agent.directTask.projectIds.flatMap((id) => {
      const target = targets.find(({ projectId }) => projectId === id);
      if (target?.mode === "checkout") return [this.projectById(id).path];
      if (target?.mode === "worktree") return [target.path];
      const candidate = candidates.find(({ projectId }) => projectId === id) ??
        agent.scopedWorktrees?.find(({ projectId, mode }) => projectId === id && mode === "automatic");
      return candidate ? [candidate.path] : [];
    });
  }

  private implementationMembers(roots: ImplementationRoot[]) {
    return roots.map((root) => {
      const project = this.projectById(root.projectId).path;
      if (root.mode === "checkout") {
        checkoutBaseline(root.path);
        return { ...root, fingerprint: fingerprintCheckout(root.path) };
      }
      if (root.mode === "worktree") {
        validateRequestedWorktree(project, root, root);
      } else {
        if (realpathSync(root.path) !== root.path) throw new Error("An isolated worktree location changed.");
        validateCandidateWorktree(project, root);
      }
      return { ...root, fingerprint: fingerprintCandidate(root.path) };
    });
  }

  private finishDirectTask(session: AgentSession, roots: ImplementationRoot[], check: CheckResult | undefined, detail?: string) {
    const task = session.agent.directTask!;
    try {
      if (detail) throw new Error(detail);
      if (this.hasRunningNativeChildren(session)) throw new Error(`A ${this.engineName} subagent is still running. Wait for it to finish and verify the candidate again.`);
      if (check?.outcome !== "passed") throw new Error(check?.summary ?? "No passing verification was recorded for this turn.");
      const members = this.implementationMembers(roots);
      if (fingerprintMemberSnapshots(members) !== check.candidateFingerprint) {
        throw new Error("An approved destination changed after verification. Recheck the current contents.");
      }
      const includesCheckout = roots.some(({ mode }) => mode === "checkout");
      const sources = members.filter(({ path, base, mode }) =>
        mode !== "checkout" && (!includesCheckout || hasWorktreeChanges(path, base)),
      ).map(({ fingerprint, ...member }) => ({
        ...member, agentId: session.agent.id, submissionId: check.submissionId, expectedFingerprint: fingerprint,
      }));
      if (!sources.length) {
        if (fingerprintMemberSnapshots(this.implementationMembers(roots)) !== check.candidateFingerprint) {
          throw new Error("An approved destination changed during delivery. Recheck the current contents.");
        }
        task.phase = "planning";
        session.agent.status = "done";
        session.agent.messages.push(message("system",
          `Implementation was verified in the approved destinations. No snapshot merge is needed.\n\nChecks: ${check.summary}`, "success"));
        return true;
      }
      let delivery: NonNullable<WorkspaceAgent["integration"]>;
      if (sources.length > 1) {
        const pinned = pinDirectCandidates(this.projects, sources);
        if (pinned.members?.every(({ base, revision }) => base === revision)) {
          for (const { projectId, path } of pinned.members) {
            removeFeatureWorktree(this.projectById(projectId).path, path);
          }
          throw new Error("The task finished without changes to the approved repositories.");
        }
        delivery = { id: check.submissionId, ...pinned, validationEvidence: check };
      } else {
        const source = sources[0];
        const pinned = pinApprovedCandidate(this.projectById(source.projectId).path, source);
        const fingerprint = fingerprintCandidate(pinned.path);
        delivery = {
          id: check.submissionId, path: pinned.path, base: source.base, fingerprint,
          sources: [{ agentId: session.agent.id, submissionId: check.submissionId, head: pinned.revision, projectId: source.projectId }],
          members: [{ ...pinned, projectId: source.projectId, base: source.base, fingerprint }],
          validationEvidence: check,
        };
      }
      try {
        if (includesCheckout && fingerprintMemberSnapshots(this.implementationMembers(roots)) !== check.candidateFingerprint) {
          throw new Error("An approved destination changed during delivery. Recheck the current contents.");
        }
      } catch (error) {
        for (const { path, projectId } of delivery.members ?? []) {
          removeFeatureWorktree(this.projectById(projectId).path, path);
        }
        throw error;
      }
      session.agent.integration = delivery;
      task.phase = "ready-for-review";
      session.agent.status = "awaiting-confirmation";
      session.agent.messages.push(message("system", includesCheckout
        ? "Verified isolated candidates are ready for review. Changes in approved local checkouts are already applied."
        : "A verified candidate is ready for review.", "success"));
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
    return this.subtree(root).some(({ agent }) => agent.nativeChild && !agent.archivedAt &&
      (agent.status === "working" || (agent.unavailableReason?.startsWith(unresolvedSubagentPrefix) || agent.unavailableReason?.startsWith(legacyUnresolvedSubagentPrefix))));
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
      throw new Error(`Wait for the ${this.engineName} subagents to finish before archiving or deleting this task.`);
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
    if (this.acceptsLiveMessages(session) && await this.deliverToWaitingTurn(session, next, next.text)) return;
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
    // A usage limit is reported per turn. Sending again is how the user retries, so it does not block.
    const { state } = this.state.provider;
    return state === "ready" || state === "demo" || state === "usage-limit";
  }

  private persist() {
    if (!this.store || !this.storageReady || this.storageFailed) return !this.storageFailed;
    try {
      this.store.save([...this.sessions.values()].map(({ agent, threadId, freshThread, run, recovery, toolVersion, checkoutReservation }) => ({
        toolVersion,
        agent,
        checkoutReservation,
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

  private update(session: AgentSession, save = true) {
    session.agent.queueDepth = session.queue.length;
    const running = Boolean(session.run?.turn || (this.demo && session.run));
    session.agent.canSteer = this.available && running;
    session.agent.canCancel = this.available && running;
    if (session.run) session.agent.status = "working";
    this.publish(save);
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
          for (const member of [...(agent.integration?.members ?? []), ...(agent.integration?.sources ?? []),
            ...(agent.scopedWorktrees ?? [])]) {
            member.projectId = agent.projectId;
          }
          for (const entry of agent.messages) {
            for (const target of entry.implementationRequest?.targets ?? []) target.projectId = agent.projectId;
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
        const scoped = agent.scopedWorktrees;
        if (scoped && (!Array.isArray(scoped) ||
            scoped.some((candidate) => !candidate || !ids.includes(candidate.projectId) ||
              typeof candidate.path !== "string" || !isAbsolute(candidate.path) ||
              !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(candidate.base) ||
              (candidate.mode !== "automatic" && candidate.mode !== "worktree") ||
              (candidate.branch !== undefined && (candidate.mode !== "worktree" || typeof candidate.branch !== "string"))) ||
            new Set(scoped.map(({ path }) => path)).size !== scoped.length)) {
          throw new Error(`Saved task ${agent.name} has invalid approved worktrees.`);
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
    for (const { agent, threadId, run, toolVersion, checkoutReservation } of saved) {
      const session = this.createAgent(agent.id, agent.name, "worker", agent.parentId, agent.goal);
      Object.assign(session.agent, agent, {
        projectId: agent.projectId, canSteer: false, canCancel: false, lifecycleBusy: undefined, awaitingSubagents: undefined, reconnecting: undefined,
      });
      session.threadId = agent.nativeChild || agent.archivedAt || run || hasSubmittedMessage(agent) ? threadId : undefined;
      session.toolVersion = toolVersion;
      session.recovery = run;
      if (checkoutReservation) {
        const { id, pid, directories } = checkoutReservation;
        if (!agent.directTask || !/^[a-f0-9-]{36}$/i.test(id) || !Number.isSafeInteger(pid) || pid < 1 ||
            !Array.isArray(directories) || directories.some((path) =>
              typeof path !== "string" || !isAbsolute(path) || basename(path) !== "orchestra-checkout-write")) {
          throw new Error("The saved checkout reservation is invalid.");
        }
        session.checkoutReservation = checkoutReservation;
      }
      session.queue = agent.messages.filter((entry) => entry.state === "queued");
      for (const entry of agent.messages) {
        if (entry.commandApproval?.status === "pending") entry.commandApproval.status = "expired";
        if (entry.state === "streaming" || entry.id === run?.messageId) entry.state = "failed";
      }
      session.agent.queueDepth = session.queue.length;
      session.agent.queuePaused = session.queue.length > 0;
      if (session.agent.directTask?.phase === "implementing") {
        session.agent.directTask.phase = "blocked";
        session.agent.directTask.detail = "Orchestra restarted during implementation. Review the approved destinations and run verification again.";
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
        throw new Error(`${this.engineName} returned an unexpected saved thread.`);
      }
      const turns = initialTurnsPage?.data ?? thread.turns;
      const turn = run?.turnId && turns?.find((entry) => entry.id === run.turnId);
      const unacknowledged = run && !run.turnId;
      if (thread.status?.type === "active" || turn && turn.status === "inProgress" ||
          unacknowledged && turns?.some(({ status }) => status === "inProgress")) {
        throw new Error(`${this.engineName} still reports an active turn. Check again after restarting the workspace.`);
      }
      const idleWithoutTurnId = unacknowledged && thread.status?.type === "idle";
      if (run && !idleWithoutTurnId && (!turn || !["completed", "failed", "interrupted"].includes(turn.status))) {
        throw new Error(`${this.engineName} has not confirmed the outcome of the saved turn. Restart Orchestra to check again.`);
      }
      this.recordModelSettings(session, settings, response);
      delete session.agent.unavailableReason;
      delete session.recovery;
      this.threadSessions.set(thread.id, session);
      session.toolVersion = toolVersion;
      if (run && idleWithoutTurnId) {
        this.supersedeImplementationRequest(session);
        const submitted = session.agent.messages.find(({ id }) => id === run.messageId);
        if (submitted?.answersProductQuestionId) this.reopenProductQuestion(session, submitted);
        session.agent.messages.push(message("system",
          `${this.engineName} reports the conversation is idle but did not confirm whether the previous message ran. Check the conversation and approved destinations before retrying.`, "notice"));
      }
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
            session.agent.messages.push({ ...message("assistant", item.text, undefined, null), providerItemId: item.id });
          }
        }
        session.agent.messages.push(message("system", `${this.engineName} confirmed that the interrupted turn completed.`, "success"));
      }
      if (run && turn && (turn.status === "failed" || turn.status === "interrupted")) {
        this.supersedeImplementationRequest(session);
        const answer = session.agent.messages.find(({ id }) => id === run.messageId);
        if (answer?.answersProductQuestionId) {
          answer.state = turn.status === "interrupted" ? "cancelled" : "failed";
          this.reopenProductQuestion(session, answer);
        }
      }
      if (this.available) this.releaseSettledCheckouts(session);
    } catch (error) {
      session.agent.unavailableReason = errorText(error);
      session.agent.status = "error";
      session.agent.messages.push(message("system", `Unable to resume this ${this.engineName} conversation. ${session.agent.unavailableReason}`, "error"));
    }
  }

  private sessionCwd(session: AgentSession) {
    if (!session.agent.projectId) return tmpdir();
    return this.projectForAgent(session).path;
  }

  private projectForAgent(session: AgentSession) {
    return this.projectById(session.agent.projectId);
  }

  private projectById(projectId: string | undefined) {
    const project = this.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error("This agent has no configured project.");
    return project;
  }

  private threadPermissions(session: AgentSession) {
    const roots = this.directTaskReadRoots(session);
    return {
      ...(roots.length ? { runtimeWorkspaceRoots: roots } : { environments: [] }),
      sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user",
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
      "Never ask the user to type a trigger phrase to continue implementation. " +
      (roots.length ? "Make planned changes to the selected repositories in a turn explicitly approved for implementation, using the writable destinations listed with that approval. " +
        this.implementationRequestInstructions(session) : "") +
      "When the user directly asks you to change a specific path, or to run something the sandbox blocks, do not stop at the sandbox error or ask the user to change settings. " +
      "Request the access you need through the normal approval flow: an escalated command, or a permission request for the exact paths, with a one-sentence reason. " +
      "The user approves or declines each request in the workspace. Request only what the current step needs, and make these requests from this task rather than a subagent. " +
      "Follow the repository instructions. Verify the candidate, call submit_check_result with the actual result, and report blockers concisely.";
  }

  private implementationRequestInstructions(session: AgentSession) {
    const toolVersion = session.threadId ? session.toolVersion ?? 0 : taskToolVersion;
    const defaultRequest = toolVersion >= implementationRequestToolVersion
      ? "call request_implementation with a summary of the intended changes"
      : `call raise_product_decision with a question starting with "${legacyImplementationRequestPrefix}" followed by a summary of the intended changes`;
    const customRequest = toolVersion >= taskToolVersion
      ? "set the targets array on request_implementation"
      : `call raise_product_decision with a question starting with "${legacyScopedImplementationPrefix}" followed by JSON with summary and targets`;
    return "If the user asks for code changes, confirms a plan, or asks you to proceed with implementation during a read-only turn, " +
      `resolve any answered product questions first, then ${defaultRequest}. ` +
      "Use automatic isolated worktrees by default. Only if the user explicitly requests a different destination, " +
      `${customRequest}. Each entry is {"projectId":"…","mode":"checkout"} for a configured local checkout, ` +
      'or {"projectId":"…","mode":"worktree","path":"/absolute/path","branch":"optional-new-branch"} for a new isolated worktree. ' +
      "Ask the user for any missing details instead of choosing a writable destination. " +
      "Use this tool instead of asking the user to type a specific phrase. End the turn and wait for the workspace approval button. ";
  }

  private selectModelSettings(): ModelSettings {
    return selectModelSettings(this.engine === "claude" ? process.env.CLAUDE_MODEL : process.env.CODEX_MODEL);
  }

  private recordModelSettings(session: AgentSession, settings: ModelSettings, response: ReportedModel) {
    const expectedModel = settings.reportedModel ?? settings.requestedModel;
    if (expectedModel && response.model && response.model !== expectedModel) {
      session.agent.messages.push(message("system",
        `${this.engineName} reported model ${response.model} instead of ${expectedModel}. Check the provider configuration if this was unexpected.`, "notice"));
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
      dynamicTools: [decisionTool, checkTool, resolveQuestionTool, implementationRequestTool],
      developerInstructions: this.instructions(session),
    });
    const { thread, modelProvider } = response;
    if (modelProvider !== this.providerId || this.threadSessions.has(thread.id)) throw new Error(`${this.engineName} returned an unexpected thread.`);
    this.recordModelSettings(session, settings, response);
    session.threadId = thread.id;
    this.trackUsage((usage) => usage.registerThread(thread.id, true, session.agent.id));
    session.freshThread = true;
    session.toolVersion = taskToolVersion;
    this.threadSessions.set(thread.id, session);
    this.publish();
    } finally { session.opening = false; }
  }

  private directTaskTurnScope(session: AgentSession, implementation?: ImplementationRoot[]) {
    const roots = implementation?.map(({ path }) => path) ?? this.directTaskReadRoots(session);
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
    const resolve = (session.toolVersion ?? 0) >= questionResolutionToolVersion
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
    if (!session.agent.directTask || !run || run.implementationRoots || run.steered || run.message.answersProductQuestionId) {
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
    return question?.productQuestion ? this.answerPrefix(question.text) + entry.text : entry.text;
  }

  private answerPrefix(question: string) {
    return `My answer to this product decision:\n\n${question}\n\nAnswer: `;
  }

  private implementationInput(text: string, approvedScope: string, roots: ImplementationRoot[]) {
    return text + "\n\nImplementation is explicitly approved for this turn. Write only in these approved destinations: " +
      JSON.stringify(roots.map(({ projectId, path, mode, ...destination }) =>
        ({ projectId, path, mode, branch: "branch" in destination ? destination.branch : undefined }))) +
      ". The approved scope is " + JSON.stringify(approvedScope) + "." +
      (roots.some(({ mode }) => mode === "checkout")
        ? " Configured checkouts may contain existing user changes. Preserve them and stay on the checked-out branch."
        : "") +
      " Keep implementation edits in this session. If a verification command is blocked by the sandbox, request command escalation through the shell tool with a one-sentence reason; the user approves it in the workspace. Run it from this task rather than a subagent. Wait for any subagents to finish, then run the agreed verification and call submit_check_result with the actual results before ending the turn.";
  }

  private async begin(session: AgentSession, next: WorkspaceMessage,
    implementation?: { roots: ImplementationRoot[]; summary: string; reservation?: CheckoutReservation }, rollback?: () => void) {
    if (!this.isActive(session)) return;
    const run: Run = { message: next, implementationRoots: implementation?.roots };
    session.run = run;
    delete next.state;
    if (rollback) {
      session.agent.status = "working";
      session.checkoutReservation = implementation?.reservation;
      if (!this.persist()) {
        delete session.run;
        delete session.checkoutReservation;
        rollback();
        this.publish(false);
        throw new Error("Orchestra could not save the approval. No implementation turn was started.");
      }
      if (session.checkoutReservation) {
        try {
          acquirePathReservations(session.checkoutReservation);
        } catch (error) {
          delete session.run;
          delete session.checkoutReservation;
          rollback();
          this.publish();
          throw error;
        }
      }
    }
    this.update(session, !rollback);
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
        approvalPolicy: "on-request",
        ...this.directTaskTurnScope(session, run.implementationRoots),
        input: input(implementation ? this.implementationInput(next.text, implementation.summary, implementation.roots) : this.answerInput(session, next)),
        additionalContext: this.pendingQuestionContext(session, next, implementation !== undefined),
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
          session.agent.messages.push(message("system", `${this.engineName} did not acknowledge this turn in time. It may still be running. Queued messages are paused; wait for a provider update or restart to reconcile before retrying.`, "warning"));
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
    if (!run.turn || !session.threadId) throw new Error(`Wait for ${this.engineName} to acknowledge the turn before stopping it.`);
    if (run.interrupting) return;
    run.interrupting = true;
    try {
      await this.server!.call("turn/interrupt", { threadId: session.threadId, turnId: run.turn.id });
    } catch (error) {
      run.interrupting = false;
      throw error;
    }
  }

  private async steer(session: AgentSession, text: string) {
    if (!session.agent.canSteer) throw new Error("There is no active turn to steer.");
    if (session.agent.directTask && session.run) {
      session.run.steered = true;
      if (this.supersedeImplementationRequest(session)) this.publish();
    }
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
          session.agent.messages.push(message("system", `${this.engineName} did not acknowledge this steering message. It may have received it; avoid resending until the turn result is clear.`, "warning"));
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
    const directTaskRun = session.run;
    this.expireCommandApprovals(directTaskRun);
    const implementationRoots = directTaskRun?.implementationRoots;
    if (session.run && !completed) {
      this.supersedeImplementationRequest(session);
      const answer = session.run.message;
      answer.state = cancelled ? "cancelled" : "failed";
      if (!session.recovery) this.reopenProductQuestion(session, answer);
    }
    delete session.run;
    delete session.agent.awaitingSubagents;
    delete session.agent.reconnecting;
    if (session.agent.canCancel !== undefined) session.agent.canCancel = false;
    for (const entry of session.stream.values()) {
      if (completed) delete entry.state;
      else entry.state = cancelled ? "cancelled" : "failed";
    }
    session.stream.clear();
    session.agent.status = completed ? "done" : cancelled ? "idle" : "error";
    if (directTaskRun && implementationRoots) {
      completed = this.finishDirectTask(session, implementationRoots, directTaskRun.check,
        completed ? undefined : detail ?? "The implementation turn did not complete.");
      if (!completed && !cancelled) directTaskRun.message.state = "failed";
    } else if (session.agent.directTask?.phase === "ready-for-review") {
      session.agent.status = "awaiting-confirmation";
    } else if (session.agent.directTask?.phase === "blocked") {
      session.agent.status = "error";
    }
    if (detail) session.agent.messages.push(message("system", detail, completed || cancelled ? "notice" : "error"));
    if (!completed && session.queue.length) {
      // Pause follow-ups, and put a failed plain message back first so Resume queue sends it in order.
      session.agent.queuePaused = true;
      const failed = directTaskRun?.message;
      if (!cancelled && failed && !implementationRoots && failed.state === "failed" && !failed.answersProductQuestionId) {
        const again: WorkspaceMessage = { ...message("user", failed.text), state: "queued" };
        const position = session.agent.messages.indexOf(session.queue[0]);
        session.queue.unshift(again);
        if (position >= 0) session.agent.messages.splice(position, 0, again);
        else session.agent.messages.push(again);
      }
    }
    this.releaseSettledCheckouts(session);
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
    const mayStillBeRunning = session.agent.status === "working" ||
      (session.agent.unavailableReason?.startsWith(unresolvedSubagentPrefix) || session.agent.unavailableReason?.startsWith(legacyUnresolvedSubagentPrefix));
    try {
      if (!threadId || !parent?.threadId) throw new Error(`The parent ${this.engineName} thread is unavailable.`);
      const { thread } = await this.server!.call<{ thread: Thread & {
        parentThreadId?: string; status?: { type: string };
        turns?: (Turn & { items?: { id: string; type: string; text?: string }[] })[];
      } }>("thread/read", { threadId, includeTurns: true });
      if (thread.id !== threadId || thread.parentThreadId !== parent.threadId) {
        throw new Error(`${this.engineName} reported a different parent for this subagent.`);
      }
      const last = thread.turns?.at(-1);
      if (mayStillBeRunning && thread.status?.type !== "active" && thread.status?.type !== "idle" &&
          (!last || !["completed", "failed", "interrupted"].includes(last.status))) {
        throw new Error(`${this.engineName} has not confirmed that the subagent stopped.`);
      }
      this.threadSessions.set(threadId, session);
      this.trackUsage((usage) => usage.registerThread(threadId, false, session.agent.id));
      for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
          if (item.type === "agentMessage" && typeof item.text === "string") this.recordNativeReply(session, item.id, item.text, null);
        }
      }
      if (thread.status?.type === "active") session.agent.status = "working";
      else if (mayStillBeRunning) {
        session.agent.status = last?.status === "completed" ? "done" : last?.status === "failed" ? "error" : "idle";
      }
      delete session.agent.unavailableReason;
    } catch (error) {
      const detail = errorText(error);
      session.agent.unavailableReason = mayStillBeRunning ? unresolvedSubagentPrefix + detail : detail;
      if (mayStillBeRunning) session.agent.status = "error";
    }
  }

  private recordNativeReply(session: AgentSession, itemId: string | undefined, text: string, createdAt?: number | null) {
    const existing = itemId && session.agent.messages.find((entry) => entry.providerItemId === itemId);
    if (existing) {
      existing.text = text;
      delete existing.state;
      session.stream.delete(itemId);
    } else {
      session.agent.messages.push({ ...message("assistant", text, undefined, createdAt), providerItemId: itemId });
    }
  }

  private registerNativeChild(parent: AgentSession, threadId: string, name?: string | null, model?: string | null, role?: string | null) {
    if (!threadId || threadId.length > 200) return;
    let child = this.threadSessions.get(threadId);
    if (child && (!child.agent.nativeChild || child.agent.parentId !== parent.agent.id)) return;
    if (!child) {
      const id = `native:${threadId}`;
      if (this.sessions.has(id)) return;
      child = this.createAgent(id, name || `${this.engineName} subagent`, "worker", parent.agent.id);
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
    if (item.agentPath && child.agent.name === `${this.engineName} subagent`) child.agent.name = item.agentPath;
    if (item.kind === "interrupted") child.agent.status = "idle";
    else if (item.kind === "completed" && child.agent.status !== "error") child.agent.status = "done";
    if (completed && (item.kind === "completed" || item.kind === "interrupted")) {
      this.signal(child.agent.id, parent.agent.id);
      this.releaseSettledCheckouts();
    }
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
          agentId: session.agent.id, runId: entry?.id ?? turnId,
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
        this.releaseSettledCheckouts();
      }
      this.publish();
    }
    if (method === "error" && !params.willRetry) {
      session.agent.status = "error";
      session.agent.messages.push(message("system", errorText(params.error?.message ?? params.message ?? `${this.engineName} subagent reported an error.`), "error"));
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
    if (method === "serverRequest/resolved" && session?.run && params.requestId !== undefined) {
      const approval = session.run.commandApprovals?.get(params.requestId)?.message.commandApproval;
      if (approval?.status === "pending") {
        approval.status = "expired";
        this.publish();
      }
      return;
    }
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
      const detail = errorText(params.error?.message ?? params.message ?? `${this.engineName} reported an error.`);
      const limit = limitDetail(this.engineName, detail, params.error);
      const run = session?.run;
      const ownTurn = !!run && (!run.turn || !params.turnId || params.turnId === run.turn.id);
      if (limit) {
        // Keep the reason visible; the workspace stays usable and recovers on the next successful turn.
        this.limitTurnId = typeof params.turnId === "string" ? params.turnId : run?.turn?.id;
        this.setProvider("usage-limit", limit);
      }
      // A retry belongs to one task's turn; the other tasks and the provider connection stay usable.
      if (session && ownTurn && params.willRetry) session.agent.reconnecting = detail;
      else if (session && ownTurn) delete session.agent.reconnecting;
      this.publish(false);
      return;
    }
    if (!session?.run) return;
    if (method === "turn/waiting") {
      const { turnId, subagents } = params as typeof params & { subagents?: number };
      if (!session.run.turn || turnId !== session.run.turn.id) return;
      const count = typeof subagents === "number" && subagents > 0 ? subagents : undefined;
      session.run.awaitingSubagents = count;
      if (count) session.agent.awaitingSubagents = count;
      else delete session.agent.awaitingSubagents;
      this.publish(false);
      return;
    }
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
      if (this.state.provider.state === "usage-limit") {
        // Clear the limit after any successful turn, or when a later turn fails for another reason.
        const limited = params.turn.id === this.limitTurnId ||
          !!limitDetail(this.engineName, errorText(params.turn.error?.message ?? ""), params.turn.error);
        if (completed || (!cancelled && !limited)) {
          delete this.limitTurnId;
          this.setProvider("ready");
        }
      }
      if (cancelled) session.agent.queuePaused = session.queue.length > 0;
      const detail = params.turn.error?.message ?? (cancelled ? "The turn was interrupted." : "The turn did not complete.");
      this.finish(session, completed, completed ? undefined : errorText(detail), cancelled);
      return;
    }
    if (!session.run.turn || params.turnId !== session.run.turn.id) return;
    if (session.agent.reconnecting && method !== "thread/status/changed") {
      // Any progress on the turn means the provider retry succeeded.
      delete session.agent.reconnecting;
      this.publish(false);
    }
    if (method === "item/started" && params.item?.type === "fileChange" && params.item.id && Array.isArray(params.item.changes)) {
      const files = params.item.changes.map((change) => change?.path);
      // An unlisted path leaves the request without a reviewable file list, so it is declined.
      if (files.length <= 200 && files.every((path) => typeof path === "string")) {
        (session.run.fileChanges ??= new Map()).set(params.item.id, files as string[]);
      }
    }
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

  private requestImplementation(session: AgentSession, rawSummary: unknown, rawTargets?: unknown) {
    if (!session.agent.directTask?.projectIds.length || session.run?.implementationRoots) {
      throw new Error("Only a read-only repository task can request implementation.");
    }
    const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
    if (!summary || summary.length > 2400) throw new Error("Provide a summary of up to 2,400 characters.");
    if (session.agent.messages.some((entry) => entry.productQuestion?.status === "pending")) {
      throw new Error("Resolve pending product questions before requesting implementation.");
    }
    if (session.queue.length) throw new Error("Wait for newer queued instructions before requesting implementation.");
    const targets = resolveWriteTargets(rawTargets, this.projects, session.agent.directTask.projectIds);
    const pending = session.agent.messages.find((entry) => entry.implementationRequest?.status === "pending");
    if (pending) {
      if (pending.text === summary && JSON.stringify(pending.implementationRequest?.targets ?? []) === JSON.stringify(targets)) {
        return pending.id;
      }
      throw new Error("An implementation request is already pending for this turn.");
    }
    const request: WorkspaceMessage = {
      ...message("system", summary, "action"),
      implementationRequest: { status: "pending", ...(targets.length ? { targets } : {}) },
    };
    session.agent.messages.push(request);
    if (!this.persist()) {
      session.agent.messages.pop();
      this.publish(false);
      throw new Error("Orchestra could not save the implementation request.");
    }
    this.publish(false);
    return request.id;
  }

  private approvalOffer(method: string, params: Event["params"], run: Run | undefined): ApprovalOffer | undefined {
    const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim().slice(0, 2400) : undefined;
    const cwd = typeof params.cwd === "string" && isAbsolute(params.cwd) ? params.cwd : undefined;
    if (method === "item/commandExecution/requestApproval") {
      const { command } = params;
      if ((params.kind != null && params.kind !== "command") || typeof command !== "string" || !command.trim() ||
          command.length > 24000 || unsafeDisplayText.test(command) || !cwd) return undefined;
      // Codex lists the choices it accepts. A sandbox escalation offers accept and cancel without decline.
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "decline"];
      const decline = commandDecline(params);
      const responses: ApprovalResponses = { decline: decline.response };
      if (decisions.includes("accept")) responses.approve = { decision: "accept" };
      if (decisions.includes("acceptForSession")) responses.approveForSession = { decision: "acceptForSession" };
      if (!responses.approve && !responses.approveForSession) return undefined;
      const extra = permissionPaths(params.additionalPermissions);
      if (!extra.complete) return undefined;
      const network = networkHost(params.networkApprovalContext) ??
        (extra.network ? "Network access" : undefined);
      return { responses, view: {
        kind: "command", command, cwd, reason, ...extra.paths, ...(network ? { network } : {}),
        ...(decline.stopsTurn ? { declineStopsTurn: true } : {}),
      } };
    }
    if (method === "item/fileChange/requestApproval") {
      const files = params.itemId ? run?.fileChanges?.get(params.itemId) : undefined;
      const grantRoot = typeof params.grantRoot === "string" && isAbsolute(params.grantRoot) ? params.grantRoot : undefined;
      // Never ask the user to approve changes they cannot see.
      if ((!files?.length && !grantRoot) || files?.some((path) => unsafeDisplayText.test(path)) ||
          (grantRoot && unsafeDisplayText.test(grantRoot))) return undefined;
      const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "acceptForSession", "decline"];
      return {
        responses: { approve: { decision: "accept" }, decline: { decision: "decline" },
          ...(offered.includes("acceptForSession") ? { approveForSession: { decision: "acceptForSession" } } : {}) },
        view: { kind: "fileChange", reason, ...(files?.length ? { files } : {}), ...(grantRoot ? { writePaths: [grantRoot] } : {}) },
      };
    }
    if (method === "item/permissions/requestApproval") {
      const requested = params.permissions && typeof params.permissions === "object" ? params.permissions as Record<string, unknown> : undefined;
      if (!requested || !cwd) return undefined;
      const extra = permissionPaths(requested);
      if (!extra.complete || (!extra.paths.writePaths && !extra.paths.readPaths && !extra.network)) return undefined;
      const granted = { ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        ...(requested.network ? { network: requested.network } : {}) };
      return {
        responses: {
          approve: { permissions: granted, scope: "turn" },
          approveForSession: { permissions: granted, scope: "session" },
          decline: { permissions: {}, scope: "turn" },
        },
        view: { kind: "permissions", cwd, reason, ...extra.paths, ...(extra.network ? { network: "Network access" } : {}) },
      };
    }
    return undefined;
  }

  private receiveApproval(id: Id, method: string, session: AgentSession | undefined, params: Event["params"]) {
    const run = session?.run;
    if (run?.commandApprovals?.has(id)) return;
    const offer = this.approvalOffer(method, params, run);
    const decline = offer?.responses.decline ?? (method === "item/permissions/requestApproval"
      ? { permissions: {}, scope: "turn" }
      : method === "item/commandExecution/requestApproval" ? commandDecline(params).response : { decision: "decline" });
    if (!offer || !session?.agent.directTask || !this.isActive(session) || !run?.turn || run.turn.id !== params.turnId ||
        run.interrupting || !params.itemId || this.storageFailed || !this.available) {
      this.server!.reply(id, decline);
      if (session && this.isActive(session) && (session.agent.directTask || session.agent.nativeChild)) {
        session.agent.messages.push(message("system", session.agent.nativeChild
          ? "Orchestra declined a permission request from this subagent. Ask the parent task to request access."
          : "Orchestra declined a permission request it could not show for review.", "warning"));
        this.publish();
      }
      return;
    }
    const choices = (["approve", "approveForSession", "decline"] as const).filter((choice) => offer.responses[choice]);
    const request: WorkspaceMessage = {
      ...message("system", approvalSummary(offer.view.kind!), "action"),
      commandApproval: { status: "pending", ...offer.view, choices },
    };
    (run.commandApprovals ??= new Map()).set(id, { message: request, responses: offer.responses });
    session.agent.messages.push(request);
    if (!this.persist()) {
      request.commandApproval!.status = "expired";
      this.server!.reply(id, decline);
    }
    this.publish(false);
  }

  private resolveCommandApproval(session: AgentSession, requestId: string, decision: ApprovalChoice) {
    if (this.demo) {
      const approval = session.agent.messages.find(({ id }) => id === requestId)?.commandApproval;
      if (approval?.status !== "pending" || !approval.choices?.includes(decision)) throw new Error("This approval is no longer pending.");
      approval.status = decision === "decline" ? "declined" : decision === "approveForSession" ? "approved-for-session" : "approved";
      this.publish();
      return;
    }
    const run = session.run;
    const pending = [...(run?.commandApprovals ?? [])].find(([, request]) => request.message.id === requestId);
    if (run?.interrupting) throw new Error("This turn is stopping.");
    if (!run || !pending || pending[1].message.commandApproval?.status !== "pending") {
      throw new Error("This approval is no longer pending.");
    }
    const [id, { message: request, responses }] = pending;
    const chosen = responses[decision];
    if (!chosen) throw new Error(`${this.engineName} did not offer that choice for this request.`);
    const approval = request.commandApproval!;
    const granting = decision !== "decline";
    // Save a consumed request before handing it off, without claiming delivery.
    approval.status = "unconfirmed";
    const saved = this.persist();
    const allowed = granting && saved && this.available && !this.storageFailed;
    if (allowed) delete run.check;
    try {
      this.server!.reply(id, allowed || !granting ? chosen : responses.decline);
    } catch {
      this.publish(false);
      throw new Error(`Orchestra could not confirm that ${this.engineName} received this decision.`);
    }
    approval.status = !saved ? "expired" : allowed ? (decision === "approveForSession" ? "approved-for-session" : "approved")
      : granting ? "expired" : "declined";
    this.publish();
    if (granting && !allowed) {
      throw new Error("Orchestra could not approve this request. Ask the agent to request it again.");
    }
  }

  private expireCommandApprovals(run?: Run) {
    for (const { message: request } of run?.commandApprovals?.values() ?? []) {
      if (request.commandApproval?.status === "pending") request.commandApproval.status = "expired";
    }
  }

  private async onRequest({ id, method, params }: Event & { id: Id }) {
    const session = params.threadId ? this.threadSessions.get(params.threadId) : undefined;
    const run = session?.run;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" ||
        method === "item/permissions/requestApproval") {
      this.receiveApproval(id, method, session, params);
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
      if (params.tool === implementationRequestTool.name) {
        const requestId = this.requestImplementation(session, params.arguments?.summary, params.arguments?.targets);
        reply(true, JSON.stringify({ requestId, message: "End the turn and wait for approval in the workspace." }));
        return;
      }
      if (params.tool === resolveQuestionTool.name) {
        this.resolveProductQuestion(session, params.arguments?.questionId);
        reply(true, "Question marked answered.");
        return;
      }
      if (params.tool === decisionTool.name) {
        const question = typeof params.arguments?.question === "string" ? params.arguments.question.trim() : "";
        if (!question || question.length > 4000) throw new Error("Provide a product question of up to 4,000 characters.");
        if ((session.toolVersion ?? 0) < taskToolVersion && question.startsWith(legacyScopedImplementationPrefix)) {
          let requested: { summary?: unknown; targets?: unknown };
          try {
            requested = JSON.parse(question.slice(legacyScopedImplementationPrefix.length));
          } catch {
            throw new Error("Provide a JSON object with summary and targets.");
          }
          if (!requested || !Array.isArray(requested.targets) || !requested.targets.length) {
            throw new Error("Provide a JSON object with summary and targets.");
          }
          const requestId = this.requestImplementation(session, requested.summary, requested.targets);
          reply(true, JSON.stringify({ requestId, message: "End the turn and wait for approval in the workspace." }));
          return;
        }
        if ((session.toolVersion ?? 0) < implementationRequestToolVersion && question.startsWith(legacyImplementationRequestPrefix)) {
          const requestId = this.requestImplementation(session, question.slice(legacyImplementationRequestPrefix.length));
          reply(true, JSON.stringify({ requestId, message: "End the turn and wait for approval in the workspace." }));
          return;
        }
        if ((session.toolVersion ?? 0) < questionResolutionToolVersion && question.startsWith(legacyQuestionResolutionPrefix)) {
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
        if (!run.implementationRoots) throw new Error("Checks can be submitted only during approved implementation.");
        run.check = { outcome, summary, submissionId: run.turn.id,
          candidateFingerprint: fingerprintMemberSnapshots(this.implementationMembers(run.implementationRoots)) };
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
    for (const task of demoTasks(this.projects[0].id)) {
      const { agent } = this.createAgent(task.id, task.name, "worker", task.parentId);
      Object.assign(agent, task);
    }
  }
}
