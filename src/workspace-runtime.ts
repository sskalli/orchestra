import { demoTasks } from "./workspace-demo.ts";
import { WorkspaceUsage } from "./workspace-usage.ts";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AppServer, codexCommand, safeError, type ProviderServer } from "./app-server.ts";
import { ClaudeAppServer, claudeProviderId } from "./claude-app-server.ts";
import type { Event, Id, Thread, Turn } from "./app-server.ts";
import { deleteRef, describeGitActivity, forkPoint, gitCommonDirectory, listWorktrees, readRefState, snapshotCheckout } from "./workspace-git-activity.ts";
import type { RefState } from "./workspace-git-activity.ts";
import { chooseModelSettings, modelOptions, newTaskEffortFor, recordReportedModel, selectModelSettings, turnModelParams, validateEffort, withDefaultEffort } from "./workspace-models.ts";
import type { ModelCatalog, ModelSettings, ProviderModel, ReportedModel } from "./workspace-models.ts";
import { knownEfforts } from "./workspace-models.ts";
import type { SavedSession, workspaceStore } from "./workspace-store.ts";
import { defaultProject, workspaceIdentity } from "./workspace-projects.ts";
import { SkillCatalog, demoSkills, normalizeSkills, skillInputFor } from "./workspace-skills.ts";
import type { ProviderSkillsResponse, WorkspaceSkill } from "./workspace-skills.ts";
import type { WorkspaceProject } from "./workspace-projects.ts";
import { messageLength, messageLengthProblem } from "./workspace-chat-recovery.ts";
import type { DiffSource } from "./workspace-diff.ts";

export type AgentStatus = "idle" | "working" | "attention" | "done" | "error" | "notice";
export type AgentRole = "worker";
export type SystemMessageKind = "error" | "action" | "warning" | "notice" | "success" | "git";
export type WorkspaceMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt?: number;
  kind?: SystemMessageKind;
  providerItemId?: string;
  /** The provider turn this user message started; such a message can be edited, which rewinds the conversation to before it. */
  turnId?: string;
  state?: "queued" | "streaming" | "failed" | "cancelled";
  /** A question the user resolved by hand is "resolved", without a linked answer. */
  productQuestion?: { status: "pending" | "resolved" } | { status: "answered"; answerMessageId: string };
  answersProductQuestionId?: string;
  commandApproval?: PermissionApproval;
};
export type ApprovalChoice = "approve" | "approveForSession" | "decline";
/** A native Codex permission request. Saved entries without a kind are command approvals. */
export type PermissionApproval = {
  status: "pending" | "approved" | "approved-for-session" | "declined" | "expired" | "unconfirmed";
  kind?: "command" | "fileChange" | "permissions";
  /** The engine's one-line headline for the request, used instead of the generic one for its kind. */
  summary?: string;
  /** The background agent that asked on the task's behalf. */
  requestedBy?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  files?: string[];
  writePaths?: string[];
  readPaths?: string[];
  network?: string;
  /** Folders that Allow for this task also lets later turns write, shown on the card before the user decides. */
  grantPaths?: string[];
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
  nativeChild?: true;
  /** A task the user talks to directly, scoped to the repositories it may read and write. */
  directTask?: { projectIds: string[] };
  /** Folders outside the selected repositories that the user allowed this task to write for the rest of the task. */
  grantedPaths?: string[];
  /** The commit each selected checkout had when the task first ran, to show the task's edits there. */
  checkoutBases?: { projectId: string; base: string }[];
  /** Linked worktrees that appeared while the task or its subagents ran, with the commit each one forked from. */
  taskWorktrees?: { projectId: string; path: string; base: string; branch?: string }[];
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
  | { type: "createTask"; name: string; projectIds: string[]; model?: string | null; effort?: string | null }
  | { type: "setModel"; agentId: string; model?: string | null; effort?: string | null }
  | { type: "answerProductQuestion"; agentId: string; questionId: string; text: string }
  | { type: "resolveProductQuestion"; agentId: string; questionId: string }
  | { type: "resolveCommandApproval"; agentId: string; requestId: string; decision: ApprovalChoice }
  | { type: "send" | "steer"; agentId: string; text: string }
  | { type: "editMessage"; agentId: string; messageId: string; text: string }
  | { type: "resumeQueue" | "cancel" | "restore" | "delete"; agentId: string }
  | { type: "rename"; agentId: string; name: string }
  | { type: "archive"; agentId: string; stopRunning?: boolean };

type Duty = "lead" | "coder" | "reviewer" | "tester" | "analyser" | "designer" | "pm";

type Run = {
  turn?: Turn;
  message: WorkspaceMessage;
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
  opening?: boolean;
  /** An edited message is rewinding the provider's thread; nothing else may start a turn meanwhile. */
  rewinding?: boolean;
  queue: WorkspaceMessage[];
  stream: Map<string, WorkspaceMessage>;
  /** What Orchestra last read from the task's repositories during the current turn. */
  gitWatch?: GitWatch;
  /** The task's Git readings, run one after another, including a finished turn's last one. */
  gitChain?: Promise<void>;
};
type GitWatch = {
  /** Branch tips per repository, to report commits and pushes made since. */
  refs: Map<string, RefState>;
  /** Linked worktree paths per repository, to notice the ones the task creates. */
  worktrees: Map<string, Set<string>>;
  timer?: ReturnType<typeof setTimeout>;
};
/** Commands often come in bursts; one reading covers the commands that finish within this window. */
const gitCheckDelayMs = 300;
/** Where a task keeps the snapshot of a checkout's contents at its first turn, per repository. */
const taskStartRef = (agentId: string) => `refs/orchestra/task-start/${agentId}`;

const questionResolutionToolVersion = 14;
/** New threads get Orchestra's question tools only; versions up to 16 also had implementation and check tools. */
const taskToolVersion = 17;
const legacyQuestionResolutionPrefix = "Resolve product question: ";
const unresolvedSubagentPrefix = "Subagent activity is unresolved. ";
const legacyUnresolvedSubagentPrefix = "Codex subagent activity is unresolved. ";
const maxSkillCatalogs = 16;
/** How long a Codex turn waits for an unloaded skill list before sending "/name" as plain text. */
const skillLookupTimeoutMs = 5_000;
const workspaceThreadConfig = { "features.multi_agent": true, "features.multi_agent_v2": true };
const modelCatalogMs = 10 * 60_000;
const modelCatalogFailureMs = 10_000;
const knownEffort = (effort: string) => knownEfforts.includes(effort);
const demoModelCatalog: ModelCatalog = { models: [
  { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", isDefault: true },
  { id: "gpt-5.5-mini", label: "GPT-5.5 mini", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
] };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const hasSubmittedMessage = (agent: WorkspaceAgent) =>
  agent.messages.some((entry) => entry.role === "user" && entry.state !== "queued");
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

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

/**
 * Brings a task saved by an earlier Orchestra up to date. Tasks used to start read-only and write only in
 * approved implementation turns with pinned delivery; their worktrees and checkout edits stay reviewable as
 * the task's own locations, and an approval request left pending becomes a plain notice.
 */
function upgradeSavedTask(agent: WorkspaceAgent) {
  const legacy = agent as WorkspaceAgent & Record<string, any>;
  const worktrees = [...(agent.taskWorktrees ?? [])];
  const addWorktree = (entry: any, projectId = entry?.projectId) => {
    if (!entry || typeof entry.path !== "string" || typeof entry.base !== "string" || typeof projectId !== "string" ||
        worktrees.some(({ path }) => path === entry.path)) return;
    worktrees.push({ projectId, path: entry.path, base: entry.base, ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}) });
  };
  if (Array.isArray(legacy.directCandidates)) for (const entry of legacy.directCandidates) addWorktree(entry);
  else if (legacy.candidate) addWorktree(legacy.candidate, agent.projectId);
  if (Array.isArray(legacy.scopedWorktrees)) for (const entry of legacy.scopedWorktrees) addWorktree(entry);
  if (worktrees.length) agent.taskWorktrees = worktrees;
  if (Array.isArray(legacy.checkoutEdits) && !agent.checkoutBases) agent.checkoutBases = legacy.checkoutEdits;
  for (const key of ["candidate", "directCandidates", "scopedWorktrees", "checkoutEdits", "integration"]) delete legacy[key];
  if (agent.directTask) agent.directTask = { projectIds: agent.directTask.projectIds };
  for (const entry of agent.messages) {
    const old = entry as WorkspaceMessage & { implementationRequest?: { status?: string } };
    if (!old.implementationRequest) continue;
    if (old.implementationRequest.status === "pending") entry.kind = "notice";
    delete old.implementationRequest;
  }
  if ((agent.status as string) === "awaiting-confirmation") agent.status = "done";
}

export class WorkspaceRuntime {
  private readonly state: WorkspaceSnapshot;
  private readonly demo: boolean;
  /** The provider's model list, kept for a while; failures are kept briefly so repeated requests do not pile up. */
  private modelCatalog?: { catalog: ModelCatalog; expiresAt: number };
  private modelCatalogRequest?: Promise<ModelCatalog>;
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
  private readonly skillCatalogs = new Map<string, SkillCatalog>();
  /** Each repository's shared Git directory, read once. */
  private readonly gitDirectories = new Map<string, string | undefined>();
  /** Git readings in progress, so closing and tests can wait for them. */
  private readonly gitChecks = new Set<Promise<void>>();

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
    // The model list is fetched again once the provider is back.
    if (state !== "ready") delete this.modelCatalog;
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

  /** Turns run in the task's repositories, or a temporary directory for a general chat, so project skills follow that scope. */
  private skillCatalog(projectIds: readonly string[]) {
    const ids = [...new Set(projectIds)];
    const paths = new Map(this.projects.map(({ id, path }) => [id, path]));
    if (ids.some((id) => !paths.has(id))) throw new Error("Unknown repository.");
    // Claude Code loads project skills only from its working directory, the task's first repository;
    // Codex loads them from every directory, so any order of the same repositories shares one list.
    const scope = this.engine === "claude" ? ids.slice(0, 1) : ids.sort();
    const cwds = scope.map((id) => paths.get(id)!);
    if (!cwds.length) cwds.push(tmpdir());
    const key = cwds.join("\n");
    let catalog = this.skillCatalogs.get(key);
    if (catalog) {
      // Keep recently used scopes last so the least recently used one is evicted first.
      this.skillCatalogs.delete(key);
    } else {
      catalog = new SkillCatalog(async () => normalizeSkills(
        await this.server!.call<ProviderSkillsResponse>("skills/list", { cwds }, 30_000)));
      if (this.skillCatalogs.size >= maxSkillCatalogs) this.skillCatalogs.delete(this.skillCatalogs.keys().next().value!);
    }
    this.skillCatalogs.set(key, catalog);
    return catalog;
  }

  /** The skills and slash commands the engine offers for "/" autocomplete in a task with these repositories. */
  async skills(projectIds: readonly string[] = []): Promise<WorkspaceSkill[]> {
    if (this.demo) return demoSkills;
    if (!this.server || this.closed) throw new Error(`${this.engineName} is still starting.`);
    return this.skillCatalog(projectIds).list();
  }

  /** Message input; Codex also gets the skill item for a leading "/skill", since it does not parse slash names itself. */
  private async userInput(session: AgentSession, text: string, message: string) {
    if (this.engine !== "codex" || !message.startsWith("/")) return input(text);
    const catalog = this.skillCatalog(session.agent.directTask?.projectIds ?? []);
    // A scope nobody opened the menu for has no list yet; load it rather than silently dropping the skill.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const skills = catalog.known ?? await Promise.race([
      catalog.list().catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(resolve, skillLookupTimeoutMs); }),
    ]);
    clearTimeout(timer);
    return [...input(text), ...skillInputFor(message, skills)];
  }

  usageExport() {
    if (!this.usage) return undefined;
    return { version: 1, modelProvider: this.providerId, ...this.usage.snapshot() };
  }

  /** Directories the chat may show local images from: the agent's own task worktrees and repositories first, then every other configured repository and task worktree. */
  imageRoots(agentId?: string) {
    const agents = this.state.agents;
    const worktrees = (agent: WorkspaceAgent) => (agent.taskWorktrees ?? []).map(({ path }) => path);
    let owner = agents.find(({ id }) => id === agentId);
    for (let depth = 0; owner?.parentId && depth < 16; depth++) owner = agents.find(({ id }) => id === owner!.parentId) ?? owner;
    const own = owner ? [...worktrees(owner),
      ...(owner.directTask?.projectIds ?? []).map((id) => this.projects.find((project) => project.id === id)?.path)] : [];
    return [...new Set([...own, ...this.projects.map(({ path }) => path), ...agents.flatMap(worktrees)]
      .filter((path): path is string => typeof path === "string" && path.length > 0))];
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
      ? new ClaudeAppServer(this.store?.claudeJournalPath, undefined, { readableRoots: this.store ? [this.store.attachmentsPath] : [] })
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
        // Listing Codex skills is cheap; knowing them lets a typed "/skill" message carry its skill item.
        if (this.engine === "codex") void this.skills().catch(() => {});
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
    if (command.type === "createTask") return this.createDirectTask(command.name, command.projectIds, command);
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
    if (command.type === "setModel") {
      await this.setModel(session, command);
      return;
    }
    if (command.type === "resolveProductQuestion") {
      this.markProductQuestionResolved(session, command.questionId);
      return;
    }
    if (command.type === "resolveCommandApproval") {
      this.resolveCommandApproval(session, command.requestId, command.decision);
      return;
    }
    if (command.type === "cancel") {
      await this.interrupt(session);
      return;
    }
    if (session.rewinding) throw new Error("Wait for the edited message to be sent.");
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
    if (command.type !== "send" && command.type !== "steer" && command.type !== "answerProductQuestion" && command.type !== "editMessage") {
      throw new Error("Unknown workspace command.");
    }
    const text = typeof command.text === "string" ? command.text.trim() : "";
    if (!text) throw new Error("Enter a message.");
    const question = command.type === "answerProductQuestion"
      ? session.agent.messages.find(({ id }) => id === command.questionId) : undefined;
    const tooLong = messageLengthProblem(text, question ? messageLength(this.answerPrefix(question.text)) : 0);
    if (tooLong) throw new Error(tooLong);
    if (command.type === "editMessage") {
      await this.editMessage(session, command.messageId, text);
      return;
    }
    if (command.type === "steer") {
      await this.steer(session, text);
      return;
    }
    if (command.type === "answerProductQuestion") {
      await this.answerProductQuestion(session, command.questionId, text);
      return;
    }
    const next = message("user", text);
    session.agent.messages.push(next);
    await this.enqueue(session, next);
  }

  private async answerProductQuestion(session: AgentSession, questionId: string, text: string) {
    const question = session.agent.directTask
      ? session.agent.messages.find((entry) => entry.id === questionId)
      : undefined;
    if (question?.productQuestion?.status !== "pending") {
      throw new Error("This product question is no longer awaiting an answer in this task.");
    }
    const answer = { ...message("user", text), answersProductQuestionId: question.id, state: "queued" as const };
    question.productQuestion = { status: "answered", answerMessageId: answer.id };
    session.agent.messages.push(answer);
    const live = this.acceptsLiveMessages(session);
    if (!live) session.queue.push(answer);
    if (!this.persist()) {
      if (!live) session.queue.pop();
      session.agent.messages.pop();
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

  /**
   * Rewinds the conversation to just before a user message that started a turn, then sends the edited text as a new
   * turn. The provider drops that turn and every later one from the thread; files on disk are not reverted.
   */
  private async editMessage(session: AgentSession, messageId: string, text: string) {
    const original = session.agent.messages.find(({ id }) => id === messageId);
    if (!session.agent.directTask || original?.role !== "user" || !original.turnId) {
      throw new Error("Only a message you sent that started a turn can be edited.");
    }
    if (session.run || session.queue.length || session.opening) {
      throw new Error("Wait for the current turn and queued messages to finish before editing a message.");
    }
    session.rewinding = true;
    try {
      if (!this.demo) await this.server!.call("thread/revert", { threadId: session.threadId, beforeTurnId: original.turnId });
    } catch (error) {
      throw new Error(`${this.engineName} could not rewind the conversation, so nothing changed. ${errorText(error)}`);
    } finally {
      session.rewinding = false;
    }
    const messages = session.agent.messages;
    const index = messages.indexOf(original);
    if (index < 0 || !this.isActive(session)) throw new Error("This conversation changed while the message was being edited.");
    const removed = new Set(messages.splice(index).map(({ id }) => id));
    // A question whose answer was removed is open again; the edited message may answer it.
    for (const entry of messages) {
      if (entry.productQuestion?.status === "answered" && removed.has(entry.productQuestion.answerMessageId)) {
        entry.productQuestion = { status: "pending" };
      }
    }
    session.agent.status = "idle";
    const next = message("user", text);
    messages.push(next);
    await this.enqueue(session, next);
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
      const steerInput = await this.userInput(session, text, entry.text);
      await this.server!.call("turn/steer", { threadId: session.threadId, expectedTurnId: run.turn.id, input: steerInput });
    } catch {
      return false;
    }
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

  /** Applies a model or effort choice; on Codex a cleared effort becomes the new model's default. */
  private async chooseModel(settings: ModelSettings, change: { model?: string | null; effort?: string | null }) {
    const needsCatalog = (typeof change.effort === "string" && !knownEffort(change.effort)) ||
      (this.engine !== "claude" && (change.model !== undefined || change.effort === null));
    const catalog = needsCatalog ? await this.listModels() : undefined;
    validateEffort(change.effort, catalog);
    const next = chooseModelSettings(settings, change);
    return this.engine === "claude" ? next : withDefaultEffort(next, catalog);
  }

  private async setModel({ agent }: AgentSession, change: { model?: string | null; effort?: string | null }) {
    if (agent.lifecycleBusy) throw new Error("Wait for the current task action to finish before changing the model.");
    const next = await this.chooseModel(agent.modelSettings ?? this.selectModelSettings(), change);
    if (agent.lifecycleBusy) throw new Error("Wait for the current task action to finish before changing the model.");
    const previous = agent.modelSettings;
    agent.modelSettings = next;
    if (!this.persist()) {
      agent.modelSettings = previous;
      this.publish(false);
      throw new Error("Orchestra could not save the model choice.");
    }
    this.publish(false);
  }

  /**
   * Lists the models and reasoning efforts the provider offers, for the picker. Concurrent requests share one
   * provider call; a list is kept for ten minutes and a failure for ten seconds.
   */
  private cachedModelCatalog() {
    if (this.demo) return demoModelCatalog;
    return this.modelCatalog && Date.now() < this.modelCatalog.expiresAt ? this.modelCatalog.catalog : undefined;
  }

  async listModels(): Promise<ModelCatalog> {
    if (this.demo) return demoModelCatalog;
    if (this.modelCatalog && Date.now() < this.modelCatalog.expiresAt) return this.modelCatalog.catalog;
    if (!this.server || !this.available) return { models: [], error: `${this.engineName} is not connected.` };
    const server = this.server;
    this.modelCatalogRequest ??= (async () => {
      let catalog: ModelCatalog;
      let keepMs = modelCatalogMs;
      // Codex 0.166 ignores modelProvider here and lists its own catalog; newer versions may scope the list.
      const customProvider = this.engine !== "claude" && this.providerId !== "openai";
      try {
        const models: ProviderModel[] = [];
        let cursor: string | null | undefined;
        for (let page = 0; page < 10; page += 1) {
          const response = await server.call<{ data?: ProviderModel[]; nextCursor?: string | null }>("model/list",
            { includeHidden: false, ...(customProvider ? { modelProvider: this.providerId } : {}), ...(cursor ? { cursor } : {}) });
          models.push(...(Array.isArray(response?.data) ? response.data : []));
          cursor = response?.nextCursor;
          if (!cursor) break;
        }
        // A custom provider serves its own configured model; Codex's catalog default describes OpenAI's.
        const options = modelOptions(models);
        if (customProvider) for (const option of options) delete option.isDefault;
        catalog = { models: options,
          ...(customProvider ? { note: `Codex may list models that ${this.providerId} does not offer.` } : {}) };
      } catch (error) {
        catalog = { models: [], error: `${this.engineName} did not list its models: ${errorText(error)}` };
        keepMs = modelCatalogFailureMs;
      }
      if (this.server === server && this.available) this.modelCatalog = { catalog, expiresAt: Date.now() + keepMs };
      return catalog;
    })().finally(() => { this.modelCatalogRequest = undefined; });
    return this.modelCatalogRequest;
  }

  private async createDirectTask(name: string, projectIds: string[], choice: { model?: string | null; effort?: string | null } = {}) {
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
    // New tasks start at a fixed effort so the choice shown before and after the first turn is the same.
    const initial = this.selectModelSettings();
    const effort = choice.effort !== undefined ? choice.effort
      // The picker has normally loaded the list already; without it, avoid starting a provider just to ask.
      : newTaskEffortFor(choice.model === undefined ? initial.requestedModel : choice.model, this.cachedModelCatalog());
    const modelSettings = await this.chooseModel(initial, { ...choice, ...(effort ? { effort } : {}) });
    const session = this.createAgent(randomUUID(), title, "worker");
    session.agent.projectId = projectIds[0];
    session.agent.directTask = { projectIds: [...projectIds] };
    session.agent.modelSettings = modelSettings;
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

  /** Where a task's edits can be reviewed. Subagent chats show their task's changes. */
  diffSources(agentId: string): DiffSource[] | "general" | undefined {
    let session = this.sessions.get(agentId);
    if (!session) return undefined;
    const visited = new Set([agentId]);
    while (!session.agent.directTask && session.agent.parentId && !visited.has(session.agent.parentId)) {
      visited.add(session.agent.parentId);
      const parent = this.sessions.get(session.agent.parentId);
      if (!parent) break;
      session = parent;
    }
    const { agent } = session;
    if (!agent.directTask?.projectIds.length) return agent.directTask ? "general" : [];
    const sources: DiffSource[] = [];
    const add = (source: DiffSource) => {
      if (!sources.some(({ path }) => path === source.path)) sources.push(source);
    };
    for (const projectId of agent.directTask.projectIds) {
      const project = this.projects.find(({ id }) => id === projectId);
      if (!project) continue;
      const checkout = agent.checkoutBases?.find((entry) => entry.projectId === projectId);
      if (checkout) add({ projectId, mode: "checkout", path: project.path, base: checkout.base });
      for (const entry of agent.taskWorktrees ?? []) {
        if (entry.projectId === projectId) add({ projectId, mode: "worktree", path: entry.path, base: entry.base, ...(entry.branch ? { branch: entry.branch } : {}) });
      }
    }
    return sources;
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
        for (const entry of affected) {
          for (const projectId of entry.agent.directTask?.projectIds ?? []) {
            const project = this.projects.find(({ id }) => id === projectId);
            if (project) void deleteRef(project.path, taskStartRef(entry.agent.id));
          }
        }
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
      upgradeSavedTask(agent);
      if (agent.directTask) {
        if (this.projects.length === 1 && agent.directTask.projectIds.length === 1) {
          agent.projectId = this.projects[0].id;
          agent.directTask.projectIds = [agent.projectId];
          for (const entry of [...(agent.taskWorktrees ?? []), ...(agent.checkoutBases ?? [])]) entry.projectId = agent.projectId;
        }
        const ids = agent.directTask.projectIds;
        if (agent.parentId || agent.nativeChild || agent.projectId !== ids[0] ||
            new Set(ids).size !== ids.length || ids.some((id) => !configuredIds.has(id))) {
          throw new Error(`Saved task ${agent.name} has an invalid repository scope.`);
        }
        // A location Orchestra cannot use is left out of the changes view rather than blocking the workspace.
        if (agent.taskWorktrees) {
          agent.taskWorktrees = Array.isArray(agent.taskWorktrees) ? agent.taskWorktrees.filter((entry) => entry &&
            ids.includes(entry.projectId) && typeof entry.path === "string" && isAbsolute(entry.path) && shaPattern.test(entry.base) &&
            (entry.branch === undefined || typeof entry.branch === "string")) : undefined;
        }
        if (agent.checkoutBases) {
          agent.checkoutBases = Array.isArray(agent.checkoutBases) ? agent.checkoutBases.filter((entry) => entry &&
            ids.includes(entry.projectId) && shaPattern.test(entry.base)) : undefined;
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
        projectId: agent.projectId, canSteer: false, canCancel: false, lifecycleBusy: undefined, awaitingSubagents: undefined, reconnecting: undefined,
      });
      session.threadId = agent.nativeChild || agent.archivedAt || run || hasSubmittedMessage(agent) ? threadId : undefined;
      session.toolVersion = toolVersion;
      session.recovery = run;
      session.queue = agent.messages.filter((entry) => entry.state === "queued");
      for (const entry of agent.messages) {
        if (entry.commandApproval?.status === "pending") entry.commandApproval.status = "expired";
        if (entry.state === "streaming" || entry.id === run?.messageId) entry.state = "failed";
      }
      session.agent.queueDepth = session.queue.length;
      session.agent.queuePaused = session.queue.length > 0;
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
        const submitted = session.agent.messages.find(({ id }) => id === run.messageId);
        if (submitted?.answersProductQuestionId) this.reopenProductQuestion(session, submitted);
        session.agent.messages.push(message("system",
          `${this.engineName} reports the conversation is idle but did not confirm whether the previous message ran. Check the conversation and the repositories before retrying.`, "notice"));
      }
      if (turn && turn.status === "completed") {
        session.agent.status = "done";
        const submitted = session.agent.messages.find((entry) => entry.id === run?.messageId);
        if (submitted) delete submitted.state;
        for (const item of turn.items ?? []) {
          if (item.type !== "agentMessage" || typeof item.text !== "string") continue;
          this.recordNativeReply(session, item.id, item.text, null);
        }
        session.agent.messages.push(message("system", `${this.engineName} confirmed that the interrupted turn completed.`, "success"));
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
      (roots.length ? `The selected repositories are ${JSON.stringify(roots)}. ` +
        "You can read and write them, including their Git data, for the whole task: create linked worktrees, branches and commits yourself. " +
        "Discuss and plan first when the request is open. For code changes, work in a linked worktree under <repository>/.worktrees/<short-name> on a new branch " +
        "(add .worktrees/ to .git/info/exclude if it is not ignored yet), commit there with clear messages, and leave the main checkout as the user left it unless they ask you to change it. " +
        "Do not open pull requests. Push or publish a branch only when the user asks; pushing needs network access, which the user approves in the workspace. Orchestra shows your commits and pushes in the chat. "
        : "No repositories are selected. ") +
      "Use raise_product_decision if you need the user to choose, then end the turn. " +
      "When orchestra_pending_questions is supplied, use its question IDs and the resolution tool it indicates only if the current user reply answers that question. Leave unrelated questions open. " +
      "If a user message answers or sets aside a question you raised, including one sent while you were working, call resolve_product_question with that question's ID so the task stops waiting for an answer. " +
      "Never ask the user to type a trigger phrase to continue. " +
      "When the user asks you to change a path outside these folders, or to run something the sandbox blocks, do not stop at the sandbox error or ask the user to change settings. " +
      "Request the access you need through the normal approval flow, with a one-sentence reason. To write outside the selected repositories, request a permission for the whole folder " +
      "you need rather than for each file or command: the user can allow a folder once for the rest of the task. " +
      "The user approves or declines each request in the workspace. Make these requests from this task rather than a subagent. " +
      "Follow the repository instructions. Run the relevant checks for your changes and report the results and any blockers concisely.";
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
      dynamicTools: [decisionTool, resolveQuestionTool],
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

  private directTaskTurnScope(session: AgentSession) {
    const roots = this.directTaskReadRoots(session);
    const writable = this.directTaskWriteRoots(session);
    return {
      cwd: roots[0] ?? tmpdir(),
      ...(roots.length ? { runtimeWorkspaceRoots: roots } : { environments: [] }),
      sandboxPolicy: writable.length
        ? { type: "workspaceWrite", writableRoots: writable, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : { type: "readOnly", networkAccess: false },
    };
  }

  /**
   * A repository task writes its selected checkouts from the first turn. Their shared Git directories are listed
   * as well, because the sandbox otherwise keeps .git read-only and every commit or worktree would need approval.
   */
  private directTaskWriteRoots(session: AgentSession) {
    const repositories = this.directTaskReadRoots(session);
    const gitDirectories = repositories.map((path) => this.gitDirectories.get(path)).filter((path): path is string => Boolean(path));
    return [...new Set([...repositories, ...gitDirectories, ...(session.agent.grantedPaths ?? [])])];
  }

  private pendingQuestionContext(session: AgentSession, answer: WorkspaceMessage) {
    if (answer.answersProductQuestionId) return undefined;
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

  /** The agent links the user's reply to a question it raised, including a reply sent while the turn ran. */
  private resolveProductQuestion(session: AgentSession, questionId: unknown) {
    const run = session.run;
    if (!session.agent.directTask || !run) {
      throw new Error("Only a reply in this task can resolve a pending product question.");
    }
    const messages = session.agent.messages;
    const answer = messages.findLast((entry) => entry.role === "user" && entry.state !== "queued" && !entry.answersProductQuestionId);
    const question = answer && messages.slice(0, messages.indexOf(answer)).find(({ id }) => id === questionId);
    if (question?.productQuestion?.status !== "pending") throw new Error("Choose a pending question from before the user's latest reply in the current task.");
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

  /** The user clears a question by hand, for example after answering it in a message the agent did not link. */
  private markProductQuestionResolved(session: AgentSession, questionId: unknown) {
    const question = session.agent.messages.find(({ id }) => id === questionId);
    if (question?.productQuestion?.status !== "pending") throw new Error("This question is no longer pending.");
    question.productQuestion = { status: "resolved" };
    if (!this.persist()) {
      question.productQuestion = { status: "pending" };
      this.publish(false);
      throw new Error("Orchestra could not save the change. The question remains pending.");
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

  private async begin(session: AgentSession, next: WorkspaceMessage) {
    if (!this.isActive(session)) return;
    const run: Run = { message: next };
    session.run = run;
    delete next.state;
    this.update(session);
    if (this.storageFailed) {
      this.finish(session, false, "The turn was paused because Orchestra could not save it.");
      return;
    }
    if (this.demo) {
      next.turnId = randomUUID();
      this.scheduleDemo(session, run);
      return;
    }
    await this.watchGitActivity(session);
    if (session.run !== run) return;
    const neighbours = this.concurrentTasks(session);
    if (neighbours.length) {
      session.agent.messages.push(message("system", `${neighbours.map(({ agent }) => agent.name).join(", ")} ${neighbours.length === 1 ? "is" : "are"} also working in ${
        [...new Set(neighbours.flatMap(({ agent }) => agent.directTask!.projectIds).filter((id) => session.agent.directTask?.projectIds.includes(id)))].join(", ")
      }. This task was asked to work only in its own worktree and leave the local checkout alone meanwhile.`, "warning"));
      this.publish();
    }
    try {
      const turnInput = await this.userInput(session, this.answerInput(session, next), next.text);
      if (session.run !== run) return;
      const { turn } = await this.server!.call<{ turn: Turn }>("turn/start", {
        threadId: session.threadId,
        approvalPolicy: "on-request",
        ...turnModelParams(session.agent.modelSettings),
        ...this.directTaskTurnScope(session),
        input: turnInput,
        additionalContext: { ...this.pendingQuestionContext(session, next), ...this.concurrencyContext(neighbours) },
      });
      session.freshThread = false;
      next.turnId ??= turn.id;
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
    if (!this.demo) {
      try {
        const expectedTurnId = session.run!.turn!.id;
        const steerInput = await this.userInput(session, text, text);
        await this.server!.call("turn/steer", {
        threadId: session.threadId,
        expectedTurnId,
        input: steerInput,
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
    if (session.run && !completed) {
      const answer = session.run.message;
      answer.state = cancelled ? "cancelled" : "failed";
      if (!session.recovery) this.reopenProductQuestion(session, answer);
    }
    delete session.run;
    delete session.agent.awaitingSubagents;
    delete session.agent.reconnecting;
    if (session.agent.canCancel !== undefined) session.agent.canCancel = false;
    this.settleStream(session, completed ? undefined : cancelled ? "cancelled" : "failed");
    const watch = session.gitWatch;
    delete session.gitWatch;
    if (watch) {
      clearTimeout(watch.timer);
      this.queueGitCheck(session, watch);
    }
    session.agent.status = completed ? "done" : cancelled ? "idle" : "error";
    if (detail) session.agent.messages.push(message("system", detail, completed || cancelled ? "notice" : "error"));
    if (!completed && session.queue.length) {
      // Pause follow-ups, and put a failed plain message back first so Resume queue sends it in order.
      session.agent.queuePaused = true;
      const failed = directTaskRun?.message;
      // Skip it when the outcome is uncertain (recovery pending): the turn may have run, so resending could repeat it.
      if (!cancelled && !session.recovery && failed && failed.state === "failed" &&
          !failed.answersProductQuestionId) {
        const again: WorkspaceMessage = { ...message("user", failed.text), state: "queued" };
        const position = session.agent.messages.indexOf(session.queue[0]);
        session.queue.unshift(again);
        if (position >= 0) session.agent.messages.splice(position, 0, again);
        else session.agent.messages.push(again);
      }
    }
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
    // A provider can complete a reply item with no text, for example before a tool call; it is not a message.
    if (!text.trim()) {
      if (existing) this.dropMessage(session, existing);
      if (itemId) session.stream.delete(itemId);
      return;
    }
    if (existing) {
      existing.text = text;
      delete existing.state;
      session.stream.delete(itemId);
    } else {
      session.agent.messages.push({ ...message("assistant", text, undefined, createdAt), providerItemId: itemId });
    }
  }

  private dropMessage(session: AgentSession, entry: WorkspaceMessage) {
    const index = session.agent.messages.indexOf(entry);
    if (index >= 0) session.agent.messages.splice(index, 1);
  }

  /** Ends streamed replies with the turn; one that never received visible text is dropped. */
  private settleStream(session: AgentSession, state: WorkspaceMessage["state"]) {
    for (const entry of session.stream.values()) {
      if (!entry.text.trim()) this.dropMessage(session, entry);
      else if (state) entry.state = state;
      else delete entry.state;
    }
    session.stream.clear();
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
        this.settleStream(session, session.agent.status === "done" ? undefined : "failed");
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
    if (method === "skills/changed") {
      for (const catalog of this.skillCatalogs.values()) catalog.invalidate();
      return;
    }
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
      session.run.message.turnId ??= params.turn.id;
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
    if (method === "item/completed" && params.item?.type === "commandExecution") this.scheduleGitCheck(session);
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const { id, text } = params.item as typeof params.item & { id?: string };
      if (typeof text !== "string") return;
      const entry = id ? session.stream.get(id) : undefined;
      if (!text.trim()) {
        if (entry) this.dropMessage(session, entry);
        if (id) session.stream.delete(id);
      } else if (entry) {
        entry.text = text;
        delete entry.state;
        session.stream.delete(id!);
      } else session.agent.messages.push({ ...message("assistant", text), providerItemId: id });
      this.publish();
    }
  }

  private approvalOffer(method: string, params: Event["params"], run: Run | undefined): ApprovalOffer | undefined {
    const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim().slice(0, 2400) : undefined;
    const label = (value: unknown, limit: number) =>
      typeof value === "string" && value.trim() && !unsafeDisplayText.test(value) ? value.trim().slice(0, limit) : undefined;
    const summary = label(params.summary, 200);
    const requestedBy = label(params.requestedBy, 200);
    const described = { ...(summary ? { summary } : {}), ...(requestedBy ? { requestedBy } : {}) };
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
        kind: "command", ...described, command, cwd, reason, ...extra.paths, ...(network ? { network } : {}),
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
        view: { kind: "fileChange", ...described, reason, ...(files?.length ? { files } : {}), ...(grantRoot ? { writePaths: [grantRoot] } : {}) },
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
    const grantPaths = choices.includes("approveForSession") ? this.grantFolders(session, offer.view) : [];
    const request: WorkspaceMessage = {
      ...message("system", offer.view.summary ?? approvalSummary(offer.view.kind!), "action"),
      commandApproval: { status: "pending", ...offer.view, ...(grantPaths.length ? { grantPaths } : {}), choices },
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
    // Allowing a request for the task also lets later turns write its folders without asking again.
    const previousGrants = session.agent.grantedPaths;
    // Only the folders the card showed are granted.
    const folders = decision === "approveForSession" ? (approval.grantPaths ?? []).filter((path) => !previousGrants?.includes(path)) : [];
    if (folders.length) session.agent.grantedPaths = [...(previousGrants ?? []), ...folders];
    // Save a consumed request before handing it off, without claiming delivery.
    approval.status = "unconfirmed";
    const saved = this.persist();
    if (!saved) session.agent.grantedPaths = previousGrants;
    const allowed = granting && saved && this.available && !this.storageFailed;
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

  /**
   * Folders "Allow for this task" would let later turns write: requested write paths, or the folders of edited files.
   * A folder taken from a single file never widens to the home folder or the filesystem root. A command's working
   * directory is not granted, since a command can be escalated for reasons other than writing there.
   */
  private grantFolders(session: AgentSession, view: Omit<PermissionApproval, "status">) {
    const writable = this.directTaskWriteRoots(session);
    const contains = (root: string, path: string) => {
      const offset = relative(root, path);
      return offset === "" || (offset !== ".." && !offset.startsWith(".." + sep) && !isAbsolute(offset));
    };
    const tooBroad = (folder: string) => folder === dirname(folder) || contains(folder, homedir());
    const candidates = [
      ...(view.writePaths ?? []),
      ...(view.files ?? []).map((file) => dirname(file)).filter((folder) => !tooBroad(folder)),
    ];
    const folders: string[] = [];
    for (const path of candidates) {
      if (isAbsolute(path) && !writable.some((root) => contains(root, path)) && !folders.includes(path)) folders.push(path);
    }
    return folders;
  }

  /** Other tasks running a turn in a repository this task works in. */
  private concurrentTasks(session: AgentSession) {
    const mine = session.agent.directTask?.projectIds ?? [];
    return [...this.sessions.values()].filter((other) => other !== session && other.run && this.isActive(other) &&
      other.agent.directTask?.projectIds.some((id) => mine.includes(id)));
  }

  private concurrencyContext(neighbours: AgentSession[]) {
    if (!neighbours.length) return {};
    return {
      orchestra_concurrent_tasks: {
        kind: "untrusted", name: "orchestra_concurrent_tasks",
        value: JSON.stringify({
          instruction: "Other tasks are working in the same repositories right now. Make your changes only in your own linked worktree, and do not edit, commit in, or switch branches in the local checkout until they finish.",
          tasks: neighbours.map(({ agent }) => ({ name: agent.name, repositories: agent.directTask!.projectIds })),
        }),
      },
    };
  }

  /**
   * Reads the repositories at turn start: branch tips and worktrees to compare against later, each repository's
   * Git directory for the sandbox, and on the task's first turn a snapshot of the local checkout to diff against.
   */
  private async watchGitActivity(session: AgentSession) {
    // A previous turn's last reading must not see this turn's changes as its own.
    await session.gitChain;
    const watch: GitWatch = { refs: new Map(), worktrees: new Map() };
    const { agent } = session;
    await Promise.all((agent.directTask?.projectIds ?? []).map(async (projectId) => {
      const repository = this.projectById(projectId).path;
      if (!this.gitDirectories.has(repository)) this.gitDirectories.set(repository, await gitCommonDirectory(repository));
      const [refs, worktrees] = await Promise.all([readRefState(repository), listWorktrees(repository)]);
      if (refs) watch.refs.set(projectId, refs);
      if (worktrees) watch.worktrees.set(projectId, new Set(worktrees.filter(({ main }) => !main).map(({ path }) => path)));
      if (agent.checkoutBases?.some((entry) => entry.projectId === projectId)) return;
      const base = await snapshotCheckout(repository, taskStartRef(agent.id));
      if (base && !agent.checkoutBases?.some((entry) => entry.projectId === projectId)) {
        agent.checkoutBases = [...(agent.checkoutBases ?? []), { projectId, base }];
      }
    }));
    session.gitWatch = watch;
  }

  /** Reads the repositories shortly after a command finishes, once for a burst of commands. */
  private scheduleGitCheck(session: AgentSession) {
    const watch = session.gitWatch;
    if (!watch) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      if (session.gitWatch === watch) this.queueGitCheck(session, watch);
    }, gitCheckDelayMs);
    watch.timer.unref?.();
  }

  private queueGitCheck(session: AgentSession, watch: GitWatch) {
    const check = (session.gitChain ?? Promise.resolve()).then(() => this.checkGitActivity(session, watch)).catch(() => {});
    session.gitChain = check;
    this.gitChecks.add(check);
    void check.finally(() => this.gitChecks.delete(check));
  }

  /**
   * Records worktrees the task created and reports its commits and pushes. A worktree belongs to the first task that
   * sees it appear while no other task works in that repository. A change Orchestra cannot attribute is left out
   * rather than shown in the wrong task.
   */
  private async checkGitActivity(session: AgentSession, watch: GitWatch) {
    if (this.sessions.get(session.agent.id) !== session || this.closed) return;
    // Read live: other tasks' readings run concurrently and may claim a worktree while this one waits for Git.
    const ownerOf = (path: string) => [...this.sessions.values()].find((other) =>
      other.agent.taskWorktrees?.some((entry) => entry.path === path));
    let changed = false;
    for (const projectId of new Set([...watch.refs.keys(), ...watch.worktrees.keys()])) {
      const repository = this.projectById(projectId).path;
      const shared = this.concurrentTasks(session).length > 0;
      const [worktrees, after] = await Promise.all([listWorktrees(repository), readRefState(repository)]);
      const known = watch.worktrees.get(projectId);
      const from = session.agent.checkoutBases?.find((entry) => entry.projectId === projectId)?.base;
      for (const { path, head, branch, main } of worktrees ?? []) {
        if (main || !known || known.has(path) || !head) continue;
        known.add(path);
        if (ownerOf(path) || shared) continue;
        const base = (from && await forkPoint(repository, head, from)) || head;
        if (ownerOf(path)) continue;
        session.agent.taskWorktrees = [...(session.agent.taskWorktrees ?? []), { projectId, path, base, ...(branch ? { branch } : {}) }];
        changed = true;
      }
      const before = watch.refs.get(projectId);
      if (!before || !after) continue;
      const checkedOut = new Map((worktrees ?? []).filter(({ branch }) => branch).map((entry) => [entry.branch!, entry]));
      // A branch in a linked worktree belongs to the task that owns the worktree, and to no task if none does.
      // A branch in the local checkout, or in none, belongs to this task unless another task works here too.
      const ownsBranch = (branch: string) => {
        const entry = checkedOut.get(branch);
        return entry && !entry.main ? ownerOf(entry.path) === session : !shared;
      };
      for (const note of await describeGitActivity(repository, projectId, before, after, ownsBranch)) {
        session.agent.messages.push(message("system", note.text, "git"));
        changed = true;
      }
      watch.refs.set(projectId, after);
    }
    if (changed && this.sessions.get(session.agent.id) === session) this.publish();
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
      if (params.tool === resolveQuestionTool.name) {
        this.resolveProductQuestion(session, params.arguments?.questionId);
        reply(true, "Question marked answered.");
        return;
      }
      if (params.tool === decisionTool.name) {
        const question = typeof params.arguments?.question === "string" ? params.arguments.question.trim() : "";
        if (!question || question.length > 4000) throw new Error("Provide a product question of up to 4,000 characters.");
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
