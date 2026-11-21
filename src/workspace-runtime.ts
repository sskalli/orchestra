import { boundedTeamHandoff, resolveTeamReuseRequest, type WorkspaceTeam } from "./workspace-teams.ts";
import { WorkspaceUsage, type DelegationDecision } from "./workspace-usage.ts";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppServer, safeError } from "./app-server.ts";
import type { Event, FileUpdate, Id, Thread, Turn } from "./app-server.ts";
import { checkClaudeCode, ClaudeCodeError, runClaudeCode } from "./claude-code.ts";
import { createFeatureWorktree, describeWorktreePatch, removeFeatureWorktree } from "./workspace-worktree.ts";
import { fingerprintCandidate, fingerprintIntegrationMembers, fingerprintMemberSnapshots, integrateProjectCandidates, pinApprovedCandidate, pinDirectCandidates, type IntegrationMember } from "./workspace-integration.ts";
import { readModelCatalog, recordReportedModel, selectModelSettings } from "./workspace-models.ts";
import type { ModelSettings, ReportedModel } from "./workspace-models.ts";
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
  sourceAgentName?: string;
  reportLabel?: string;
  providerItemId?: string;
  orchestrationRunId?: string;
  reuseTeamId?: string;
  state?: "queued" | "streaming" | "failed" | "cancelled";
  implementationProposalId?: string;
  approval?: { id: string; state: "pending" | "accepted" | "declined" | "expired"; canAccept?: boolean };
};
export type ImplementationProposal = {
  id: string;
  projectId: string;
  brief: string;
  status: "awaiting-approval" | "implementing" | "blocked" | "ready-for-review" | "confirmed";
  coderId?: string;
  candidatePath?: string;
  candidateRevision?: string;
  verification?: { outcome: CheckResult["outcome"]; summary: string; fingerprint: string };
  detail?: string;
};
export type WorkspaceAgent = {
  id: string;
  name: string;
  role: AgentRole;
  parentId?: string;
  projectId?: string;
  teamId?: string;
  goal?: string;
  duty?: Duty;
  modelSettings?: ModelSettings;
  candidate?: Candidate;
  implementationProposal?: ImplementationProposal;
  directTask?: { projectIds: string[]; phase: "planning" | "implementing" | "blocked" | "ready-for-review"; detail?: string };
  directCandidates?: (Candidate & { projectId: string })[];
  acceptanceOwnerId?: string;
  requiredChecks?: CheckDuty[];
  validationEvidence?: Partial<Record<CheckDuty, CheckResult>>;
  submissionId?: string;
  submissionFingerprint?: string;
  validationTargetId?: string;
  validationIntegrationId?: string;
  integration?: { id: string; path: string; base: string; fingerprint: string; sources: { agentId: string; submissionId: string; head: string; fingerprint?: string; projectId?: string }[]; members?: IntegrationMember[]; confirmed?: boolean; validationEvidence?: CheckResult };
  check?: CheckResult;
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
  projects: WorkspaceProject[];
  workspaceKey: string;
  provider: { name: WorkspaceProvider; state: "demo" | "connecting" | "ready" | "signed-out" | "error" | "usage-limit"; message?: string };
  agents: WorkspaceAgent[];
  teams?: WorkspaceTeam[];
  usage?: Omit<ReturnType<WorkspaceUsage["summary"]>, "byRun"> & { issue?: string };
};
export type AgentSignal = { id: string; senderId: string; recipientId: string };
export type WorkspaceCommand =
  | { type: "createTask"; name: string; projectIds: string[] }
  | { type: "startImplementation"; agentId: string; text?: string }
  | { type: "send" | "steer"; agentId: string; text: string }
  | { type: "resumeQueue" | "cancel" | "restore" | "delete"; agentId: string }
  | { type: "archive"; agentId: string; stopRunning?: boolean }
  | { type: "approveImplementation"; agentId: string; proposalId: string }
  | { type: "approval"; agentId: string; approvalId: string; decision: "accept" | "decline" };

type Candidate = { path: string; base: string };
type CheckDuty = "reviewer" | "tester";
type CheckResult = { submissionId: string; targetAgentId?: string; candidateFingerprint?: string;
  outcome: "passed" | "changes-requested" | "blocked"; summary: string; recordedAt: number };
const legacyRequiredChecks: readonly CheckDuty[] = ["reviewer", "tester"];
type Duty = "coder" | "reviewer" | "tester" | "analyser" | "designer" | "pm";

type Run = {
  taskImplementation?: boolean;
  turn?: Turn; delegated?: boolean; reuseRequest?: ReturnType<typeof resolveTeamReuseRequest>; reuseLookupAttempted?: boolean; messageOffset?: number; message: WorkspaceMessage; check?: WorkspaceAgent["check"];
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
const managementToolVersion = 12;
const analysisToolVersion = 12;
const coordinatorToolVersion = 13;
const workspaceThreadConfig = { "features.multi_agent": false, "features.multi_agent_v2": false };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const hasSubmittedMessage = (agent: WorkspaceAgent) =>
  agent.messages.some((entry) => entry.role === "user" && entry.state !== "queued");
const tool = {
  type: "function",
  deferLoading: false,
  name: "delegate_agent",
  description: "Start an addressable team lead, coder, reviewer, tester, analyser, designer, or product adviser. The pilot can assign isolated work directly to a coder or start a lead for coordinated work. Leads can start multiple coders in isolated worktrees. For coders, set requiredChecks to the independent checks that add evidence. Use routine complexity for narrow, predictable work and complex for difficult or high-risk work. Omit complexity for typical work. Set afterAgentId to attach a check to that coder and wait for its current submission. Coders can delegate reviewer, tester, or designer children for their own candidate. The pilot sets projectIds for a new multi-repo lead or a direct coder handling one cohesive change across explicitly selected repositories. A direct multi-repo coder runs the joint check and reports its result; use a lead if independent checks are required. For a repository-scoped assignment, set projectId if there is more than one eligible repository. Checks attached with afterAgentId inherit the coder's repository.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, goal: { type: "string" },
      duty: { type: "string", enum: ["lead", "coder", "reviewer", "tester", "analyser", "designer", "pm"] },
      projectId: { type: "string" },
      projectIds: { type: "array", items: { type: "string" } },
      complexity: { type: "string", enum: ["routine", "complex"] },
      requiredChecks: { type: "array", items: { type: "string", enum: ["reviewer", "tester"] } },
      afterAgentId: { type: "string" } },
    required: ["name", "goal", "duty"],
    additionalProperties: false,
  },
};
const findTeamTool = {
  type: "function",
  name: "find_archived_team",
  description: "Select an archived team by exact name or team ID when the user explicitly asks to reuse it. Returns a compact handoff. New delegates in this turn use that team.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
};
const inspectGitTool = {
  type: "function",
  deferLoading: false,
  name: "inspect_project_git",
  description: "Read current local branches, HEAD, and worktree status. The pilot must specify projectId in a multi-repository workspace; Leads can inspect any repository assigned to their team.",
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
  description: "Confirm a direct-report coder's submission after checking required evidence. A direct multi-repo submission returns clean delivery worktrees and pinned revisions. This does not merge the candidate.",
  inputSchema: {
    type: "object",
    properties: { agentId: { type: "string" } },
    required: ["agentId"],
    additionalProperties: false,
  },
};
const integrateTool = {
  type: "function", name: "integrate_candidates",
  description: "Prepare accepted coder candidates for integration. Within each repository combine multiple sources in an isolated worktree. For cross-repository work include accepted sources for every assigned repository. Delegate a tester without afterAgentId to validate the pinned candidates together, then confirm_integration. No project branches are merged.",
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
  description: "Record the result of the assigned verification. Use passed only when the required scope passed, changes-requested for findings or failures, or blocked when verification could not finish.",
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
  description: "Notify your parent and the pilot of an unresolved product decision. An analyser can offer a specific, single-repository implementation requiring explicit user approval.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      implementation: { type: "object", properties: { projectId: { type: "string" }, brief: { type: "string" } },
        required: ["projectId", "brief"], additionalProperties: false },
    },
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
  private modelCatalog: Awaited<ReturnType<typeof readModelCatalog>> = [];
  private readonly projects: WorkspaceProject[];
  private readonly store?: ReturnType<typeof workspaceStore>;
  private storageFailed = false;
  private storageReady = false;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly threadSessions = new Map<string, AgentSession>();
  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private readonly signalListeners = new Set<(signal: AgentSignal) => void>();
  private server?: AppServer;
  private readonly teams = new Map<string, WorkspaceTeam>();
  private usage?: WorkspaceUsage;
  private usageIssue?: string;
  private started = false;
  private closed = false;
  private simulationRunning = false;
  private readonly simulationTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor({ cwd, projects = [defaultProject(cwd)], demo = false, provider = "codex", modelProvider = "openai", store, claudeExecutable }: {
    cwd: string;
    projects?: WorkspaceProject[];
    demo?: boolean;
    provider?: WorkspaceProvider;
    modelProvider?: string;
    claudeExecutable?: string;
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
    this.claudeExecutable = claudeExecutable;
    this.state = {
      project: { name: this.projects.length === 1 ? basename(path) : "Workspace", path },
      projects: this.projects,
      workspaceKey: workspaceIdentity(this.projects),
      modelProvider,
      provider: { name: provider, state: demo ? "demo" : "connecting" },
      agents: [],
    };
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
    const usage = this.usage ?? (this.usageIssue ? new WorkspaceUsage() : undefined);
    const state = { ...this.state, teams: this.teamRecords() };
    if (!usage) return structuredClone(state);
    const { total, byAgent, byTeam, unattributedTokens } = usage.summary();
    return structuredClone({
      ...state, usage: { total, byAgent, byTeam, unattributedTokens, issue: this.usageIssue },
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

  private teamRecords() {
    const latest = new Map<string, number | undefined>();
    for (const { agent } of this.sessions.values()) {
      if (!agent.teamId) continue;
      if (!latest.has(agent.teamId)) latest.set(agent.teamId, agent.archivedAt);
      else {
        const previous = latest.get(agent.teamId);
        latest.set(agent.teamId, previous && agent.archivedAt ? Math.max(previous, agent.archivedAt) : undefined);
      }
    }
    return [...this.teams.values()].filter((team) => latest.has(team.id))
      .map((team) => ({ ...team, archivedAt: latest.get(team.id) }));
  }

  private updateTeamHandoff(agent: WorkspaceAgent) {
    const team = agent.teamId && this.teams.get(agent.teamId);
    if (!team || !agent.candidate || !agent.projectId) return;
    const report = agent.messages.findLast((entry) => entry.role === "assistant" && !entry.state)?.text;
    const paths = [...(team.handoff?.paths ?? [])];
    const candidates = agent.directCandidates ? agent.integration?.members ?? []
      : [{ ...agent.candidate, projectId: agent.projectId, revision: undefined }];
    const revisions = team.handoff?.sourceRevisions?.filter(
      (entry) => !candidates.some(({ projectId }) => projectId === entry.projectId)) ?? [];
    for (const { projectId, path, base, revision } of candidates) {
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args],
          { cwd: path, env, encoding: "utf8", timeout: 5000 });
        const changed = git("diff", "--name-only", "-z", base, "--").split("\0");
        const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0");
        const changedPaths = [...changed, ...untracked].filter(Boolean);
        paths.unshift(...(team.projectIds.length > 1 ? changedPaths.map((file) => `${projectId}/${file}`) : changedPaths));
        revisions.push({ projectId, revision: revision ?? base });
      } catch { /* Acceptance is already verified. Keep the report if enrichment fails. */ }
    }
    team.handoff = boundedTeamHandoff({
      summary: report ?? team.handoff?.summary,
      decisions: [agent.goal ?? agent.name, ...(team.handoff?.decisions ?? [])],
      paths,
      sourceRevisions: revisions,
    });
  }

  private usageTeam(agent: WorkspaceAgent) {
    if (agent.teamId) return agent.teamId;
    let root = agent;
    const visited = new Set<string>();
    while (root.parentId && root.parentId !== coordinatorId) {
      if (visited.has(root.id)) return undefined;
      visited.add(root.id);
      const parent = this.sessions.get(root.parentId)?.agent;
      if (!parent) return undefined;
      root = parent;
    }
    return root.role === "lead" ? root.id : undefined;
  }

  private trackTurn(session: AgentSession, threadId: string, turnId: string, entry: WorkspaceMessage, recovered = false) {
    this.trackUsage((usage) => usage.registerTurn(threadId, turnId, {
      agentId: session.agent.id,
      runId: entry.orchestrationRunId ?? entry.id,
      teamId: this.usageTeam(session.agent),
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
      const workspace = this.store?.loadWorkspace();
      saved = workspace?.sessions.filter(({ agent }) => !agent.simulation);
      if (saved) this.restore(saved, workspace?.teams);
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
    try {
      this.usage = new WorkspaceUsage(this.store?.usagePath);
      this.trackUsage((usage) => usage.retainAgents([...this.sessions.keys()]));
    } catch {
      this.usageIssue = "Usage tracking is unavailable because its local records could not be read.";
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
      if (this.providerId === "openai") {
        try {
          this.modelCatalog = await readModelCatalog(server);
        } catch {
          coordinator.agent.messages.push(message("system",
            "Codex model discovery is unavailable. New agents will use the configured provider defaults or CODEX_MODEL.", "notice"));
        }
      }
      if (!coordinator.threadId) await this.attachThread(coordinator);
      for (const entry of saved ?? []) {
        if (entry.agent.archivedAt) continue;
        if (entry.threadId && this.sessions.get(entry.agent.id)?.threadId === entry.threadId) {
          await this.resumeThread(entry);
        } else if (this.approvedProposal(this.sessions.get(entry.agent.id)!)?.status === "implementing") {
          this.finishApprovedImplementation(this.sessions.get(entry.agent.id)!, false,
            "Orchestra restarted before the approved coder started. Open a fresh investigation to retry.");
        } else if ((entry.agent.role === "lead" || entry.agent.directTask) && !this.sessions.get(entry.agent.id)?.threadId) {
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
    if (command.type === "createTask") return this.createDirectTask(command.name, command.projectIds);
    const session = this.sessions.get(command.agentId);
    if (!session) throw new Error("This conversation no longer exists.");
    if (command.type === "archive" || command.type === "restore" || command.type === "delete") {
      await this.lifecycle(session, command);
      return;
    }
    if (!this.isActive(session)) throw new Error("Restore this archived conversation before messaging it.");
    if (command.type === "startImplementation") {
      await this.startDirectTaskImplementation(session, command.text);
      return;
    }
    if (command.type === "approveImplementation") {
      await this.approveImplementation(session, command.proposalId);
      return;
    }
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

  private async createDirectTask(name: string, projectIds: string[]) {
    if (!this.available || this.demo || this.state.provider.name !== "codex" || this.storageFailed) {
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
    if (session.run || session.opening || session.recovery || session.queue.length || session.approvals.size ||
        task.phase === "implementing") {
      throw new Error("Wait for the task to finish its current turn before approving implementation.");
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
    const assignment = message("user",
      (text?.trim() || "Implement the plan we agreed in this chat.") +
      "\n\nImplementation is explicitly approved for this turn. Write only in these isolated worktrees: " +
      JSON.stringify(roots.map(({ projectId, path }) => ({ projectId, path }))) +
      ". Run the agreed verification and call submit_check_result before ending the turn.");
    task.phase = "implementing";
    delete task.detail;
    delete session.agent.integration;
    session.agent.messages.push(assignment);
    await this.begin(session, assignment, undefined, true);
  }

  private directTaskCandidates(session: AgentSession) {
    const { candidate, directCandidates, projectId } = session.agent;
    return directCandidates ?? (candidate && projectId ? [{ ...candidate, projectId }] : []);
  }

  private finishDirectTask(session: AgentSession, check: CheckResult | undefined, detail?: string) {
    const task = session.agent.directTask!;
    try {
      if (detail) throw new Error(detail);
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

  private async approveImplementation(analysis: AgentSession, proposalId: string) {
    const proposal = analysis.agent.implementationProposal;
    if (!proposal || proposal.id !== proposalId || proposal.status !== "awaiting-approval") {
      throw new Error("This implementation proposal is no longer awaiting approval.");
    }
    if (analysis.run || analysis.opening || analysis.recovery || analysis.agent.status !== "done") {
      throw new Error("Wait for the investigation to finish before approving implementation.");
    }
    if (!this.available || this.storageFailed || this.demo || this.state.provider.name !== "codex") {
      throw new Error("Codex must be available to start the approved implementation.");
    }
    const project = this.proposalProject(analysis, proposal.projectId);
    let candidate: Candidate;
    try {
      candidate = createFeatureWorktree(project.path);
    } catch (error) {
      proposal.status = "blocked";
      proposal.detail = `Unable to create an isolated candidate: ${errorText(error)}`;
      this.publish();
      return;
    }
    const worker = this.createAgent(randomUUID(), `Implement ${analysis.agent.name}`, "worker", analysis.agent.id, proposal.brief);
    Object.assign(worker.agent, {
      projectId: project.id, teamId: analysis.agent.teamId, duty: "coder", candidate,
      acceptanceOwnerId: coordinatorId, requiredChecks: [], modelSettings: this.selectModelSettings(),
    });
    proposal.status = "implementing";
    proposal.coderId = worker.agent.id;
    const assignment = message("user", proposal.brief +
      "\n\nImplement only the approved scope in the isolated worktree. Run the requested verification and call submit_check_result with the actual outcome and evidence before finishing. Report any blockers.");
    assignment.orchestrationRunId = proposal.id;
    assignment.state = "queued";
    worker.agent.messages.push(assignment);
    worker.queue.push(assignment);
    worker.agent.queueDepth = 1;
    if (!this.persist()) {
      this.sessions.delete(worker.agent.id);
      this.state.agents.pop();
      removeFeatureWorktree(project.path, candidate.path);
      delete proposal.coderId;
      proposal.status = "blocked";
      proposal.detail = "Orchestra could not save the approved implementation.";
      this.publish(false);
      return;
    }
    this.signal(analysis.agent.id, worker.agent.id);
    await this.startDelegation(worker);
  }

  private proposalProject(analysis: AgentSession, id: string) {
    const project = this.projects.find((entry) => entry.id === id);
    if (!project || (analysis.agent.teamId && !this.teams.get(analysis.agent.teamId)?.projectIds.includes(id))) {
      throw new Error("Choose one configured repository within this investigation's scope.");
    }
    return project;
  }

  private approvedProposal(coder: AgentSession) {
    const parent = coder.agent.parentId && this.sessions.get(coder.agent.parentId);
    const proposal = parent ? parent.agent.implementationProposal : undefined;
    return proposal?.coderId === coder.agent.id ? proposal : undefined;
  }

  private finishApprovedImplementation(coder: AgentSession, completed: boolean, detail?: string) {
    const proposal = this.approvedProposal(coder);
    if (!proposal) return;
    const candidate = coder.agent.candidate;
    const submissionId = coder.agent.submissionId;
    try {
      if (!completed || !candidate || !submissionId || !coder.agent.submissionFingerprint) {
        throw new Error(detail ?? "The coder did not finish the approved implementation.");
      }
      if (!proposal.verification || proposal.verification.fingerprint !== coder.agent.submissionFingerprint) {
        throw new Error("The coder did not record verification for the current candidate.");
      }
      if (proposal.verification.outcome !== "passed") throw new Error(proposal.verification.summary);
      const project = this.projects.find(({ id }) => id === proposal.projectId)!;
      const delivery = pinApprovedCandidate(project.path, {
        ...candidate, agentId: coder.agent.id, submissionId, expectedFingerprint: coder.agent.submissionFingerprint,
      });
      proposal.candidateRevision = delivery.revision;
      proposal.candidatePath = delivery.path;
      proposal.status = "ready-for-review";
      delete proposal.detail;
    } catch (error) {
      proposal.status = "blocked";
      proposal.detail = errorText(error);
      coder.agent.status = "error";
      coder.agent.messages.push(message("system", proposal.detail, "error"));
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
          const proposal = entry.agent.implementationProposal;
          if (!ids.has(entry.agent.id) && proposal?.coderId && ids.has(proposal.coderId)) {
            delete proposal.coderId;
            if (proposal.status !== "confirmed") {
              proposal.status = "blocked";
              if (!proposal.candidateRevision) delete proposal.verification;
              proposal.detail = "The implementation coder was deleted. Request a fresh proposal in this investigation.";
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
        const remainingTeams = new Set(this.teamRecords().map((team) => team.id));
        for (const teamId of this.teams.keys()) if (!remainingTeams.has(teamId)) this.teams.delete(teamId);
        this.trackUsage((usage) => usage.removeAgents([...ids]));
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
      const sessions = [...this.sessions.values()].filter(({ agent }) => !agent.simulation);
      this.store.save(sessions.map(({ agent, threadId, freshThread, run, recovery, waitingFor, toolVersion }) => ({
        waitingFor,
        toolVersion,
        agent,
        threadId: agent.archivedAt || run || recovery || (!freshThread && hasSubmittedMessage(agent)) ? threadId : undefined,
        run: run ? { messageId: run.message.id, turnId: run.turn?.id } : recovery,
      })), this.teamRecords());
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
    const parent = parentId ? this.sessions.get(parentId) : undefined;
    const agent: WorkspaceAgent = { id, name, role, parentId, goal, projectId: role === "coordinator" ? undefined : parent?.agent.projectId ?? (this.projects.length === 1 ? this.projects[0].id : undefined),
      status: "idle", messages: [], queueDepth: 0, canSteer: false };
    const session: AgentSession = { agent, queue: [], stream: new Map(), approvals: new Map() };
    this.state.agents.push(agent);
    this.sessions.set(id, session);
    return session;
  }

  private restore(saved: SavedSession[], savedTeams: WorkspaceTeam[] = []) {
    const entries = new Map(saved.map((entry) => [entry.agent.id, entry]));
    if (this.projects.length === 1) {
      for (const { agent } of saved) {
        if (agent.directTask) {
          if (agent.directTask.projectIds.length) {
            agent.directTask.projectIds = [this.projects[0].id];
            agent.projectId = this.projects[0].id;
            for (const member of [...(agent.integration?.members ?? []), ...(agent.integration?.sources ?? [])]) {
              member.projectId = agent.projectId;
            }
          }
        } else if (agent.role !== "coordinator") agent.projectId = this.projects[0].id;
        if (agent.implementationProposal) agent.implementationProposal.projectId = this.projects[0].id;
      }
    }
    for (const { agent } of saved) {
      if (agent.role === "coordinator") continue;
      if (agent.directTask) {
        const ids = agent.directTask.projectIds;
        if (agent.role !== "worker" || agent.parentId || !Array.isArray(ids) || agent.projectId !== ids[0] ||
            new Set(ids).size !== ids.length || ids.some((id) => !this.projects.some((project) => project.id === id))) {
          throw new Error(`Saved task ${agent.name} has an invalid repository scope.`);
        }
        continue;
      }
      if (!this.projects.some((project) => project.id === agent.projectId)) {
        throw new Error(`Saved agent ${agent.name} has an unknown project.`);
      }
      const parent = agent.parentId && entries.get(agent.parentId)?.agent;
      if (!parent) {
        throw new Error(`Saved agent ${agent.name} has an invalid project assignment.`);
      }
    }
    this.teams.clear();
    for (const team of savedTeams) {
      if (this.projects.length === 1) {
        const projectId = this.projects[0].id;
        team.projectIds = [projectId];
        if (team.handoff?.sourceRevisions) {
          team.handoff.sourceRevisions = team.handoff.sourceRevisions.map(({ revision }) => ({ projectId, revision }));
        }
      }
      if (team.projectIds.some((id) => !this.projects.some((project) => project.id === id))) {
        throw new Error(`Saved team ${team.name} has an unknown project.`);
      }
      this.teams.set(team.id, team);
    }
    const migratedTeams = new Set<string>();
    for (const { agent } of saved) {
      if (agent.role !== "lead" || agent.teamId) continue;
      agent.teamId = agent.id;
      this.teams.set(agent.id, { id: agent.id, name: agent.name, scope: agent.goal?.trim().slice(0, 2000) || agent.name,
        projectIds: [agent.projectId!] });
      migratedTeams.add(agent.id);
    }
    for (const { agent } of saved) {
      const visited = new Set([agent.id]);
      let parent = agent.parentId && entries.get(agent.parentId)?.agent;
      while (!agent.teamId && parent && parent.role !== "coordinator" && !visited.has(parent.id)) {
        visited.add(parent.id);
        agent.teamId = parent.teamId;
        parent = parent.parentId && entries.get(parent.parentId)?.agent;
      }
    }
    for (const { agent } of saved) {
      if (agent.teamId && !this.teams.get(agent.teamId)?.projectIds.includes(agent.projectId!)) {
        throw new Error(`Saved agent ${agent.name} has an invalid team assignment.`);
      }
      const proposal = agent.implementationProposal;
      const coder = proposal?.coderId ? entries.get(proposal.coderId)?.agent : undefined;
      if (proposal && (agent.duty !== "analyser" ||
          !this.projects.some(({ id }) => id === proposal.projectId) ||
          (agent.teamId && !this.teams.get(agent.teamId)?.projectIds.includes(proposal.projectId)) ||
          (coder && (coder.duty !== "coder" || coder.parentId !== agent.id || coder.projectId !== proposal.projectId)))) {
        throw new Error(`Saved investigation ${agent.name} has an invalid implementation proposal.`);
      }
      const parentAgent = agent.parentId && entries.get(agent.parentId)?.agent;
      const directCandidates = agent.directCandidates;
      if (directCandidates && (!Array.isArray(directCandidates) || directCandidates.length < 2 ||
          (agent.directTask ? directCandidates.length !== agent.directTask.projectIds.length ||
            directCandidates.some(({ projectId }, index) => projectId !== agent.directTask?.projectIds[index])
            : agent.duty !== "coder" || parentAgent?.role !== "coordinator") ||
          directCandidates[0]?.projectId !== agent.projectId || directCandidates[0]?.path !== agent.candidate?.path ||
          directCandidates[0]?.base !== agent.candidate?.base ||
          directCandidates.some((candidate) => !candidate || typeof candidate.path !== "string" ||
            !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(candidate.base) ||
            !this.projects.some(({ id }) => id === candidate.projectId) ||
            (agent.teamId && !this.teams.get(agent.teamId)?.projectIds.includes(candidate.projectId))) ||
          new Set(directCandidates.map(({ projectId }) => projectId)).size !== directCandidates.length ||
          new Set(directCandidates.map(({ path }) => path)).size !== directCandidates.length)) {
        throw new Error(`Saved coder ${agent.name} has invalid cross-repo assignments.`);
      }
      if (parentAgent && parentAgent.role !== "coordinator" &&
          (parentAgent.teamId !== agent.teamId ||
           (parentAgent.projectId !== agent.projectId && (parentAgent.role !== "lead" || !agent.teamId) &&
             !(parentAgent.duty === "analyser" && agent.duty === "coder" &&
               parentAgent.implementationProposal?.coderId === agent.id &&
               parentAgent.implementationProposal.projectId === agent.projectId)))) {
        throw new Error(`Saved agent ${agent.name} has an invalid project assignment.`);
      }
    }
    for (const { agent } of saved) {
      if (agent.duty !== "coder" || agent.status !== "done" || !agent.submissionId || !agent.submissionFingerprint ||
          !agent.teamId || !migratedTeams.has(agent.teamId)) continue;
      const team = this.teams.get(agent.teamId)!;
      team.handoff = boundedTeamHandoff({
        summary: agent.messages.findLast((entry) => entry.role === "assistant" && !entry.state)?.text ?? team.handoff?.summary,
        decisions: [agent.goal ?? agent.name, ...(team.handoff?.decisions ?? [])],
        sourceRevisions: agent.candidate && agent.projectId ? [{ projectId: agent.projectId, revision: agent.candidate.base }] : undefined,
      });
    }
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
      if (session.agent.directTask?.phase === "implementing") {
        session.agent.directTask.phase = "blocked";
        session.agent.directTask.detail = "Orchestra restarted during implementation. Review the worktree and run verification again.";
      }
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
      const refreshTools = session.agent.role === "coordinator" ? toolVersion !== coordinatorToolVersion
        : session.agent.role === "lead" || session.agent.duty === "coder" ? toolVersion !== managementToolVersion
        : session.agent.duty === "analyser" ? toolVersion !== analysisToolVersion
        : (session.agent.duty === "reviewer" || session.agent.duty === "tester") && (toolVersion ?? 0) < 8;
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
          : session.agent.duty === "coder" ? "awaiting-confirmation" : "done";
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
      if (run && this.approvedProposal(session)) {
        if (turn && turn.status === "completed" && session.agent.candidate) {
          try { session.agent.submissionFingerprint = fingerprintCandidate(session.agent.candidate.path); }
          catch { delete session.agent.submissionFingerprint; }
          this.finishApprovedImplementation(session, true);
        } else {
          this.finishApprovedImplementation(session, false, "Orchestra could not confirm the interrupted implementation.");
        }
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
      if (this.approvedProposal(session)?.status === "implementing") this.finishApprovedImplementation(session, false, detail);
      session.agent.status = "error";
      session.agent.messages.push(message("system", `Unable to resume this Codex conversation. ${session.agent.unavailableReason}`, "error"));
    }
  }

  private sessionCwd(session: AgentSession) {
    if (session.agent.candidate) return session.agent.candidate.path;
    if (session.agent.directTask && !session.agent.projectId) return tmpdir();
    if (session.agent.role === "coordinator") return this.projects[0].path;
    return this.projectForAgent(session).path;
  }

  private projectForAgent(session: AgentSession) {
    const project = this.projects.find((entry) => entry.id === session.agent.projectId);
    if (!project) throw new Error("This agent has no configured project.");
    return project;
  }

  private eligibleProjects(session: AgentSession) {
    if (session.agent.role === "coordinator") return this.projects;
    const ids = session.agent.directCandidates?.map(({ projectId }) => projectId) ??
      (session.agent.role === "lead" && session.agent.teamId ? this.teams.get(session.agent.teamId)?.projectIds : undefined);
    return ids ? this.projects.filter((project) => ids.includes(project.id)) : [this.projectForAgent(session)];
  }

  private selectProject(session: AgentSession, requested: unknown) {
    const eligible = this.eligibleProjects(session);
    if (requested === undefined && eligible.length === 1) return eligible[0];
    const project = eligible.find((entry) => entry.id === requested);
    if (!project) {
      if (session.agent.role !== "coordinator" && eligible.length === 1) {
        throw new Error("A team cannot change its assigned project.");
      }
      throw new Error(`Choose a projectId from: ${eligible.map((entry) => entry.id).join(", ")}.`);
    }
    return project;
  }

  private checkerIntegration(session: AgentSession) {
    if (!session.agent.validationIntegrationId || !session.agent.validationTargetId) return;
    const integration = this.sessions.get(session.agent.validationTargetId)?.agent.integration;
    if (integration?.id === session.agent.validationIntegrationId) return integration;
  }

  private candidatePaths(session: AgentSession) {
    const integration = this.checkerIntegration(session);
    return session.agent.directCandidates?.map(({ path }) => path) ?? integration?.members?.map((member) => member.path) ??
      (session.agent.candidate ? [session.agent.candidate.path] : []);
  }

  private threadPermissions(session: AgentSession) {
    const directTask = session.agent.directTask;
    const candidates = directTask ? this.directTaskReadRoots(session) : this.candidatePaths(session);
    return {
      ...(directTask && !candidates.length ? { environments: [] } : {
        runtimeWorkspaceRoots: candidates.length ? candidates : [this.sessionCwd(session)],
      }),
      sandbox: session.agent.duty === "coder" ? "workspace-write" : "read-only",
      approvalPolicy: this.fileApprovalPolicy(session),
      approvalsReviewer: "user",
    };
  }

  private directTaskReadRoots(session: AgentSession) {
    return session.agent.directTask!.projectIds.map((id) => this.projects.find((project) => project.id === id)!.path);
  }

  private fileApprovalPolicy(session: AgentSession) {
    return session.agent.duty === "coder" && session.agent.candidate && !session.agent.directCandidates ? "on-request" : "never";
  }

  private instructions(session: AgentSession) {
    if (session.agent.directTask) {
      const roots = session.agent.directTask.projectIds.map((id) => this.projects.find((project) => project.id === id)!);
      return "Work directly with the user in this task. " +
        (roots.length ? `The selected repositories for read-only investigation are ${JSON.stringify(roots)}. ` : "No repositories are selected. ") +
        "Plan and discuss by default. Perform code changes only in a turn explicitly approved for implementation, using its isolated worktree paths. " +
        "Follow the repository instructions. Verify the candidate, call submit_check_result with the actual result, and report blockers concisely.";
    }
    const role = session.agent.role === "worker" ? session.agent.duty ?? "analyser" : session.agent.role;
    const instructions = readFileSync(new URL(`../roles/${role}.md`, import.meta.url), "utf8");
    const projectContext = session.agent.directCandidates
      ? `Write only in these isolated worktrees: ${JSON.stringify(session.agent.directCandidates.map(({ projectId, path }) => ({ projectId, path })))}. ` +
        "Follow each worktree's AGENTS.md. Run the joint check from the brief against these worktrees. Report per-repo changes, actual joint-check results, and blockers concisely."
      : session.agent.role === "coordinator"
      ? `Configured projects (ID and repository root): ${JSON.stringify(this.projects)}. ` +
        (this.projects.length === 1
          ? "Follow the project's AGENTS.md for coding conventions, commands, and local workflow."
          : "Specify projectId for a single-repo assignment or Git inspection, and projectIds for explicitly selected cross-repo assignments. Ask the user if any intended project is unclear.")
      : `Your assigned project is ${this.projectForAgent(session).id}; its source repository is ${this.projectForAgent(session).path}. ` +
        `Your working directory is ${this.sessionCwd(session)}. Stay in that working directory and follow its AGENTS.md. ` +
        (session.agent.candidate ? "Work on the candidate worktree, not the original checkout." : "");
    const manifest = this.checkerIntegration(session)?.members;
    const scopedContext = manifest
      ? `Test the exact integration worktrees together. Use these repository paths: ${JSON.stringify(manifest)}. Each is read-only.\n`
      : session.agent.role === "lead"
        ? `Team repository IDs: ${this.eligibleProjects(session).map((project) => project.id).join(", ")}. Set projectId for each repository-scoped assignment when there is more than one choice.\n`
        : "";
    const proposalContext = this.approvedProposal(session) || session.agent.duty === "analyser"
      ? `\nConfigured source repositories for read-only inspection: ${JSON.stringify(
        session.agent.teamId ? this.projects.filter(({ id }) => this.teams.get(session.agent.teamId!)?.projectIds.includes(id)) : this.projects)}.`
      : "";
    return `${scopedContext}${manifest ? "" : projectContext}${proposalContext}\nUse Orchestra's tools for delegation and product questions.\n\n${instructions}`;
  }

  private selectModelSettings(complexity?: unknown): ModelSettings {
    return selectModelSettings(this.modelCatalog, process.env.CODEX_MODEL, complexity);
  }

  private recordModelSettings(session: AgentSession, settings: ModelSettings, response: ReportedModel) {
    const expectedModel = settings.reportedModel ?? settings.requestedModel;
    if (expectedModel && response.model && response.model !== expectedModel) {
      session.agent.messages.push(message("system",
        `Codex reported model ${response.model} instead of ${expectedModel}. Check the provider configuration if this was unexpected.`, "notice"));
    }
    session.agent.modelSettings = recordReportedModel(settings, response, this.modelCatalog);
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
      ...(session.agent.role !== "worker" && { environments: [] }),
      dynamicTools: session.agent.directTask || this.approvedProposal(session) ? [decisionTool, checkTool]
        : session.agent.role === "worker" && session.agent.duty !== "coder"
        ? [decisionTool, ...(session.agent.duty === "reviewer" || session.agent.duty === "tester" ? [checkTool] : [])]
        : [tool, relayTool, listTool, inspectGitTool, reportTool, decisionTool,
          ...((session.agent.role === "coordinator" || session.agent.role === "lead") ? [confirmCoderTool] : []),
          ...(session.agent.role === "lead" ? [integrateTool, confirmIntegrationTool] : []),
          ...(session.agent.role === "coordinator" ? [findTeamTool] : [])],
      developerInstructions: this.instructions(session),
    });
    const { thread, modelProvider } = response;
    if (modelProvider !== this.providerId || this.threadSessions.has(thread.id)) throw new Error("Codex returned an unexpected thread.");
    this.recordModelSettings(session, settings, response);
    session.threadId = thread.id;
    this.trackUsage((usage) => usage.registerThread(thread.id, true, session.agent.id));
    session.freshThread = true;
    session.toolVersion = session.agent.role === "coordinator" ? coordinatorToolVersion
      : session.agent.duty === "analyser" ? analysisToolVersion : managementToolVersion;
    this.threadSessions.set(thread.id, session);
    this.publish();
    } finally { session.opening = false; }
  }

  private availableReports(session: AgentSession, message?: WorkspaceMessage) {
    const reports = this.subtree(session).filter((entry) => entry !== session && this.isActive(entry));
    if (!message?.reuseTeamId) return reports;
    const runId = message.orchestrationRunId ?? message.id;
    return reports.filter(({ agent }) => agent.teamId === message.reuseTeamId &&
      agent.messages.some((entry) => entry.orchestrationRunId === runId));
  }

  private teamReportContext(session: AgentSession, entry?: WorkspaceMessage) {
    const reusedTeam = entry?.reuseTeamId && this.teams.get(entry.reuseTeamId);
    const handoff = reusedTeam ? {
      orchestra_reused_team: { kind: "untrusted", name: "orchestra_reused_team", value: JSON.stringify(reusedTeam) },
    } : undefined;
    if (session.agent.role === "worker" && session.agent.duty !== "coder") return handoff;
    const briefOnly = Boolean(session.agent.directCandidates || this.approvedProposal(session));
    const priorMessages = briefOnly
      ? session.agent.messages.filter((message) => message.id !== entry?.id && message.role !== "system" && !message.state)
      : session.agent.messages;
    const previousChat = session.freshThread && priorMessages.length ? {
      orchestra_previous_chat: {
        kind: "untrusted",
        name: "orchestra_previous_chat",
        value: JSON.stringify(priorMessages.slice(-12).map(({ role, text, state }) => ({ role, text: text.slice(0, 2000), state }))),
      },
    } : undefined;
    if (briefOnly) return handoff || previousChat ? { ...handoff, ...previousChat } : undefined;
    const team = this.availableReports(session, entry);
    const reports = team.map(({ agent }) => {
      const recent = agent.messages.findLast((entry) => entry.role === "assistant" && !entry.state);
      return {
        agentId: agent.id, parentId: agent.parentId, projectId: agent.projectId,
        projectIds: agent.directCandidates?.map(({ projectId }) => projectId), name: agent.name, duty: agent.duty,
        status: agent.status, submissionId: agent.submissionId, teamId: agent.teamId,
        check: agent.check && { ...agent.check, summary: agent.check.summary.slice(0, 2400) },
        latestReply: recent?.text.slice(0, 2400),
      };
    });
    return {
      ...handoff,
      ...previousChat,
      orchestra_team_reports: {
        kind: "untrusted",
        name: "orchestra_worker_reports",
        value: JSON.stringify(reports),
      },
    };
  }

  private directTaskTurnScope(session: AgentSession, implementation: boolean) {
    const roots = implementation ? this.candidatePaths(session) : this.directTaskReadRoots(session);
    return {
      cwd: roots[0] ?? tmpdir(),
      ...(roots.length ? { runtimeWorkspaceRoots: roots } : { environments: [] }),
      sandboxPolicy: implementation
        ? { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "readOnly", networkAccess: false },
    };
  }

  private async begin(session: AgentSession, next: WorkspaceMessage, parent?: Turn, taskImplementation = false) {
    if (!this.isActive(session)) return;
    const run: Run = { message: next, messageOffset: session.agent.messages.length, taskImplementation };
    if (session.agent.role === "coordinator" && this.state.provider.name === "codex" && !this.demo) {
      run.reuseRequest = resolveTeamReuseRequest(next.text, this.teamRecords());
    }
    try {
      if (next.reuseTeamId && !this.teams.has(next.reuseTeamId)) {
        throw new Error("This team's saved handoff is no longer available. Select a team again.");
      }
      this.checkCandidateAccess(session);
      if (session.agent.duty === "reviewer" || session.agent.duty === "tester") run.checkTarget = this.captureCheckTarget(session);
    } catch (error) {
      next.state = "failed";
      delete session.agent.check;
      session.agent.status = "error";
      session.agent.queuePaused = session.queue.length > 0;
      session.agent.messages.push(message("system", `The turn could not start: ${errorText(error)}`, "action"));
      this.finishApprovedImplementation(session, false, errorText(error));
      if (taskImplementation) this.finishDirectTask(session, undefined, errorText(error));
      this.update(session);
      this.reportDelegation(session, false);
      return;
    }
    if (session.agent.duty === "coder") {
      const proposal = this.approvedProposal(session);
      if (proposal) {
        next.orchestrationRunId = proposal.id;
        proposal.status = "implementing";
        delete proposal.detail;
        delete proposal.candidatePath;
        delete proposal.candidateRevision;
        delete proposal.verification;
      }
      session.agent.submissionId = randomUUID();
      delete session.agent.submissionFingerprint;
      delete session.agent.validationEvidence;
      for (const lead of this.sessions.values()) {
        if (lead.agent.integration?.sources.some((source) => source.agentId === session.agent.id)) delete lead.agent.integration.confirmed;
      }
    }
    const duty = session.agent.duty;
    if (duty === "reviewer" || duty === "tester") {
      delete session.agent.check;
      this.recordValidationEvidence(duty, run.checkTarget, "The latest check has no verified result.");
    }
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
        ...(session.agent.directTask ? this.directTaskTurnScope(session, taskImplementation) : session.agent.candidate && {
          cwd: this.sessionCwd(session),
          runtimeWorkspaceRoots: this.candidatePaths(session),
          sandboxPolicy: session.agent.duty === "coder"
            ? { type: "workspaceWrite", writableRoots: this.candidatePaths(session), networkAccess: false,
                excludeTmpdirEnvVar: true, excludeSlashTmp: true }
            : { type: "readOnly", networkAccess: false },
        }),
        input: input(next.text),
        additionalContext: this.teamReportContext(session, next),
        effort: session.agent.modelSettings?.effort,
        parentTurnId: parent?.id,
        rootTurnId: parent ? parent.rootTurnId ?? parent.id : undefined,
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
    const directTaskRun = session.run?.taskImplementation ? session.run : undefined;
    const binding = session.run?.checkTarget;
    const approvedAssignment = this.approvedProposal(session) ? session.run?.message : undefined;
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
      try {
        session.agent.submissionFingerprint = session.agent.directCandidates
          ? fingerprintIntegrationMembers(session.agent.directCandidates)
          : fingerprintCandidate(session.agent.candidate.path);
      }
      catch (error) { completed = false; detail = `Unable to snapshot the candidate: ${errorText(error)}`; }
    }
    const duty = session.agent.duty;
    const validation = duty === "reviewer" || duty === "tester";
    if (completed && validation && !session.agent.check) {
      const summary = "The turn finished without recording a review or test outcome. Request a fresh check with submit_check_result.";
      if (binding) session.agent.check = { submissionId: binding.submissionId, targetAgentId: binding.agentId,
        candidateFingerprint: binding.fingerprint, outcome: "blocked", summary, recordedAt: Date.now() };
      session.agent.messages.push(message("system", summary, "action"));
    }
    if (validation) this.recordValidationEvidence(duty, binding, detail ?? "The check did not complete.", session.agent.check);
    session.agent.status = completed
      ? session.agent.duty === "coder" ? "awaiting-confirmation"
        : validation && session.agent.check?.outcome === "changes-requested" ? "error"
          : validation && session.agent.check?.outcome !== "passed" ? "attention" : "done"
      : cancelled ? "idle" : "error";
    if (!completed && session.agent.implementationProposal?.status === "awaiting-approval") {
      session.agent.implementationProposal.status = "blocked";
      session.agent.implementationProposal.detail = "The investigation did not finish. Request a fresh proposal.";
    }
    if (directTaskRun) {
      completed = this.finishDirectTask(session, directTaskRun.check,
        completed ? undefined : detail ?? "The implementation turn did not complete.");
      if (!completed && !cancelled) directTaskRun.message.state = "failed";
    } else if (session.agent.directTask?.phase === "ready-for-review") {
      session.agent.status = "awaiting-confirmation";
    } else if (session.agent.directTask?.phase === "blocked") {
      session.agent.status = "error";
    }
    this.finishApprovedImplementation(session, completed, detail);
    if (this.approvedProposal(session)?.status === "blocked") completed = false;
    if (!completed && !cancelled && approvedAssignment) approvedAssignment.state = "failed";
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
    if (target.agent.role === "lead" && target.agent.integration && session.agent.candidate?.path === target.agent.integration.path &&
        (session.agent.validationIntegrationId === target.agent.integration.id ||
          (!session.agent.validationIntegrationId && !target.agent.integration.members))) {
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
      const fingerprint = integration.members ? fingerprintIntegrationMembers(integration.members) : fingerprintCandidate(integration.path);
      if (integration.fingerprint !== binding.fingerprint || fingerprint !== binding.fingerprint) {
        throw new Error("The integration snapshot changed. Rebuild and test it again.");
      }
      for (const source of integration.sources) {
        const coder = this.sessions.get(source.agentId);
        const sourcePath = coder?.agent.candidate?.path;
        if (sourcePath && integration.members?.some((member) => member.path === sourcePath)) {
          throw new Error("A delivery worktree shares a coder's worktree. Rebuild the delivery and rerun joint tests.");
        }
        if (!coder || !this.isActive(coder) || coder.run || coder.recovery || coder.queue.length || coder.agent.status !== "done" ||
            (source.projectId && coder.agent.projectId !== source.projectId) ||
            coder.agent.submissionId !== source.submissionId || !source.fingerprint || !coder.agent.candidate ||
            fingerprintCandidate(coder.agent.candidate.path) !== source.fingerprint) throw new Error("An integration source changed. Confirm its updated submission, rebuild, and retest the integration.");
      }
    } else if (target.agent.submissionId !== binding.submissionId || !coderIsReady(target.agent) || target.run ||
        !target.agent.candidate || fingerprintCandidate(target.agent.candidate.path) !== binding.fingerprint) {
      throw new Error("The coder submission changed. Run a fresh check for the updated submission.");
    }
  }

  private recordValidationEvidence(duty: CheckDuty, binding: Run["checkTarget"], summary: string, result?: CheckResult) {
    if (!binding) return;
    const target = this.sessions.get(binding.agentId)?.agent;
    if (!target) return;
    const evidence = result ?? {
      submissionId: binding.submissionId, targetAgentId: binding.agentId, candidateFingerprint: binding.fingerprint,
      outcome: "blocked", summary, recordedAt: Date.now(),
    } satisfies CheckResult;
    // Keep attempt evidence with the snapshot even if its checker's conversation is removed.
    if (target.duty === "coder" && target.submissionId === binding.submissionId) {
      target.validationEvidence ??= {};
      target.validationEvidence[duty] = evidence;
    } else if (duty === "tester" && target.integration?.id === binding.submissionId) {
      target.integration.validationEvidence = evidence;
      delete target.integration.confirmed;
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
    const candidates = this.candidatePaths(session);
    if (!candidates.length) return;
    const conflict = [...this.sessions.values()].some((other) => this.isActive(other) && other !== session &&
      this.candidatePaths(other).some((path) => candidates.includes(path)) && !other.waitingFor && other.agent.status === "working" &&
      (session.agent.duty === "coder" || other.agent.duty === "coder") && other.agent.role === "worker");
    if (conflict && session.agent.role === "worker") throw new Error("Wait for the current work on this candidate to finish.");
  }

  private reportDelegation(session: AgentSession, completed: boolean, turn?: Turn, result?: string,
    checkOutcome?: NonNullable<WorkspaceAgent["check"]>["outcome"]) {
    if (!session.agent.parentId || this.closed || !this.isActive(session)) return;
    const parent = this.sessions.get(session.agent.parentId);
    const acceptanceOwner = this.sessions.get(session.agent.acceptanceOwnerId ?? session.agent.parentId);
    const outcome = this.approvedProposal(session)?.status === "ready-for-review"
      ? "prepared a pinned candidate for review."
      : session.agent.status === "awaiting-confirmation"
      ? `finished its turn and is awaiting confirmation${acceptanceOwner ? ` from ${acceptanceOwner.agent.name}` : ""}.`
      : completed ? "finished its turn." : "could not complete its turn.";
    const report = session.agent.directCandidates && result && result.length > 2400
      ? result.slice(0, 2400) + "\nFull report available with read_agent_report."
      : result;
    const text = `${session.agent.name} ${outcome}${report ? "\n" + report : ""}`;
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
    if ((method === "turn/started" || method === "turn/completed") && params.threadId && params.turn &&
        (!session.run.turn || session.run.turn.id === params.turn.id)) {
      this.trackTurn(session, params.threadId, params.turn.id, session.run.message);
    }
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
      if (completed && !session.run.delegated && (session.agent.role === "coordinator" || session.agent.role === "lead")) {
        const entry = session.run.message;
        this.trackUsage((usage) => usage.recordDecision({
          id: `direct:${entry.id}`, at: Date.now(), agentId: session.agent.id, runId: entry.orchestrationRunId ?? entry.id,
          teamId: this.usageTeam(session.agent), reason: "Completed the turn without delegating.",
          model: session.agent.modelSettings?.reportedModel,
        }));
      }
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
      if (params.tool === findTeamTool.name) {
        const run = session.run!;
        const { message: entry, reuseRequest, delegated } = run;
        if (session.agent.role === "coordinator") run.reuseLookupAttempted = true;
        const name = typeof params.arguments?.name === "string" ? params.arguments.name.trim().toLowerCase() : "";
        if (session.agent.role !== "coordinator" || !reuseRequest || !name || delegated || entry.reuseTeamId) {
          throw new Error("Select an archived team only when the user explicitly names it, before delegating.");
        }
        const matches = this.teamRecords().filter((team) => team.archivedAt && reuseRequest.teamIds.includes(team.id));
        if (!matches.length) throw new Error(`No archived team matches "${reuseRequest.reference}". Ask the user to check the name or ID.`);
        if (matches.length > 1) {
          const options = matches.map((team) => ({ teamId: team.id, projects: team.projectIds, scope: team.scope.slice(0, 160) }));
          throw new Error(`Several archived teams match that request. Ask the user to reply with Reuse team <ID> for the intended team. ${JSON.stringify(options)}`);
        }
        const [team] = matches;
        if (name !== team.name.toLowerCase() && name !== team.id.toLowerCase()) {
          throw new Error(`The user requested "${reuseRequest.reference}". Look up the complete team name or ID for that request.`);
        }
        entry.reuseTeamId = team.id;
        this.publish();
        reply(true, JSON.stringify(matches[0]));
        return;
      }
      if (params.tool === decisionTool.name) {
        const question = typeof params.arguments?.question === "string" ? params.arguments.question.trim() : "";
        if (!question || question.length > 4000) throw new Error("Provide a product question of up to 4,000 characters.");
        const implementation = params.arguments?.implementation;
        let proposal: ImplementationProposal | undefined;
        if (implementation !== undefined) {
          const current = session.agent.implementationProposal;
          if (session.agent.duty !== "analyser" || current?.coderId) {
            throw new Error("Only an investigation without an approved coder can propose implementation.");
          }
          const brief = typeof implementation?.brief === "string" ? implementation.brief.trim() : "";
          if (!brief || brief.length > 4000 || typeof implementation?.projectId !== "string") {
            throw new Error("Provide one repository and a concrete implementation brief of up to 4,000 characters.");
          }
          const project = this.proposalProject(session, implementation.projectId);
          proposal = { id: randomUUID(), projectId: project.id, brief, status: "awaiting-approval" };
          session.agent.implementationProposal = proposal;
        }
        const parent = session.agent.parentId ? this.sessions.get(session.agent.parentId) : undefined;
        const recipients = session.agent.directTask ? [session]
          : [...(proposal ? [session] : []), parent, this.sessions.get(coordinatorId)];
        for (const recipient of new Set(recipients)) {
          if (recipient && this.isActive(recipient)) {
            recipient.agent.messages.push({ ...message("system", `Product decision from ${session.agent.name}: ${question}`, "action", session.agent.id),
              ...(proposal && { implementationProposalId: proposal.id }) });
            this.signal(session.agent.id, recipient.agent.id);
          }
        }
        this.publish();
        reply(true, proposal ? "The implementation proposal is awaiting explicit user approval. Stop before editing."
          : session.agent.directTask ? "Product decision posted in this task chat."
          : "Product decision posted in the parent and pilot chats.");
        return;
      }
      if (params.tool === checkTool.name) {
        const proposal = this.approvedProposal(session);
        const taskRun = session.run!.taskImplementation ? session.run : undefined;
        if (!taskRun && !proposal && session.agent.duty !== "reviewer" && session.agent.duty !== "tester") {
          throw new Error("Only an assigned verifier or approved implementation coder can submit a check result.");
        }
        const outcome = params.arguments?.outcome;
        const summary = typeof params.arguments?.summary === "string" ? params.arguments.summary.trim() : "";
        if ((outcome !== "passed" && outcome !== "changes-requested" && outcome !== "blocked") ||
          !summary || summary.length > 24_000) throw new Error("Provide a valid outcome and summary.");
        if (taskRun) {
          taskRun.check = { submissionId: randomUUID(), outcome, summary: summary.slice(0, 2400), recordedAt: Date.now(),
            candidateFingerprint: fingerprintIntegrationMembers(this.directTaskCandidates(session)) };
          reply(true, "Verification recorded for the current candidate. Record it again if the candidate changes.");
          return;
        }
        if (proposal) {
          proposal.verification = { outcome, summary: summary.slice(0, 2400),
            fingerprint: fingerprintCandidate(session.agent.candidate!.path) };
          this.publish();
          reply(true, "Verification recorded for the current candidate. Record it again if the candidate changes.");
          return;
        }
        const binding = session.run!.checkTarget;
        this.assertCheckCurrent(binding);
        session.run!.check = { submissionId: binding!.submissionId, targetAgentId: binding!.agentId,
          candidateFingerprint: binding!.fingerprint, outcome, summary, recordedAt: Date.now() };
        reply(true, "Check result recorded for this turn.");
        return;
      }
      if (this.approvedProposal(session)) throw new Error("Complete the approved assignment directly and report verification.");
      if (session.agent.role === "worker" && session.agent.duty !== "coder") throw new Error("Workers can raise product decisions through their parent.");
      if (params.tool === inspectGitTool.name) {
        const project = this.selectProject(session, params.arguments?.projectId);
        const candidate = session.agent.directCandidates?.find(({ projectId }) => projectId === project.id);
        reply(true, JSON.stringify(inspectGit(candidate?.path ?? (session.agent.role === "worker" ? this.sessionCwd(session) : project.path))));
        return;
      }
      const reports = this.availableReports(session, session.run!.message);
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
        if ((session.agent.role !== "lead" && session.agent.role !== "coordinator") ||
            coder?.agent.status !== "awaiting-confirmation" || coder.run || coder.recovery || coder.queue.length) {
          throw new Error("Choose a coder on your team whose submission is awaiting confirmation.");
        }
        const ownerId = coder.agent.acceptanceOwnerId ?? (session.agent.role === "lead" ? coder.agent.parentId : undefined);
        if (ownerId !== session.agent.id || !coder.agent.candidate || !coder.agent.submissionId) {
          throw new Error("Only the assigned acceptance owner can confirm this submission.");
        }
        const directMembers = coder.agent.directCandidates?.map((member) => ({
          ...member, fingerprint: fingerprintCandidate(member.path),
        }));
        const fingerprint = directMembers ? fingerprintMemberSnapshots(directMembers) : fingerprintCandidate(coder.agent.candidate.path);
        if (coder.agent.acceptanceOwnerId && !coder.agent.submissionFingerprint) {
          throw new Error("Orchestra could not verify the submitted snapshot. Ask the coder to submit it again.");
        }
        if (coder.agent.submissionFingerprint && coder.agent.submissionFingerprint !== fingerprint) throw new Error("The candidate changed after submission. Ask the coder to submit it again.");
        const checks = this.scopedChecks(coder);
        if (checks.some((entry) => entry.run || entry.recovery || entry.waitingFor || entry.queue.length || entry.agent.status === "working")) {
          throw new Error("Wait for this coder's scheduled review and testing to finish before confirming.");
        }
        for (const duty of coder.agent.requiredChecks ?? legacyRequiredChecks) {
          const latest = coder.agent.validationEvidence?.[duty] ?? checks
            .filter((entry) => entry.agent.duty === duty && entry.agent.check?.submissionId === coder.agent.submissionId &&
              (!entry.agent.check?.targetAgentId || entry.agent.check.targetAgentId === coder.agent.id))
            .map((entry) => entry.agent.check!).sort((a, b) => b.recordedAt - a.recordedAt)[0];
          if (latest?.outcome !== "passed" || latest.submissionId !== coder.agent.submissionId || latest.candidateFingerprint !== fingerprint) {
            throw new Error(`The current submission needs a fresh passing ${duty} report for this exact candidate. ${latest?.summary ?? "Request a fresh check."}`);
          }
        }
        if (directMembers) {
          const delivery = pinDirectCandidates(this.projects, directMembers.map(({ fingerprint, ...member }) => ({
            ...member, agentId: coder.agent.id, submissionId: coder.agent.submissionId!, expectedFingerprint: fingerprint,
          })));
          coder.agent.integration = { id: randomUUID(), ...delivery, confirmed: true };
        }
        coder.agent.submissionFingerprint = fingerprint;
        coder.agent.status = "done";
        const proposal = this.approvedProposal(coder);
        if (proposal?.status === "ready-for-review") proposal.status = "confirmed";
        this.updateTeamHandoff(coder.agent);
        const deliveryLocations = directMembers && coder.agent.integration?.members?.map(
          ({ projectId, path, revision }) => `${projectId} at ${revision}: ${path}`).join("\n");
        const notice = `${session.agent.name} confirmed ${coder.agent.name}'s implementation.` +
          (deliveryLocations ? `\nPinned delivery worktrees:\n${deliveryLocations}` : "");
        for (const recipient of new Set([coder, session, this.sessions.get(coordinatorId)])) {
          recipient?.agent.messages.push(message("system", notice, "success",
            recipient === coder ? session.agent.id : coder.agent.id));
        }
        this.signal(session.agent.id, coder.agent.id);
        if (session.agent.id !== coordinatorId) this.signal(session.agent.id, coordinatorId);
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
        if (reports.some((entry) => entry.agent.validationTargetId === session.agent.id && (entry.run || entry.recovery))) throw new Error("Wait for the current integration validation to finish.");
        const sources = ids.map((id) => {
          const coder = reports.find((entry) => entry.agent.id === id && entry.agent.duty === "coder" && entry.agent.parentId === session.agent.id);
          if (!coder || coder.run || coder.recovery || coder.queue.length || coder.agent.status !== "done" || !coder.agent.candidate ||
              !coder.agent.projectId || !coder.agent.submissionId || !coder.agent.submissionFingerprint) throw new Error("Every integration source must be a confirmed, idle coder submission from this team.");
          const fingerprint = fingerprintCandidate(coder.agent.candidate.path);
          if (fingerprint !== coder.agent.submissionFingerprint) throw new Error("A coder candidate changed after acceptance. Resubmit and validate it first.");
          return { agentId: id, projectId: coder.agent.projectId, ...coder.agent.candidate, submissionId: coder.agent.submissionId, expectedFingerprint: fingerprint };
        });
        const projects = this.eligibleProjects(session);
        if (projects.some((project) => !sources.some((source) => source.projectId === project.id))) {
          throw new Error("Include an accepted coder submission from every team repository before preparing cross-repository delivery.");
        }
        const combined = integrateProjectCandidates(projects, sources);
        session.agent.integration = { id: randomUUID(), ...combined };
        const locations = combined.members?.map((member) => `${member.projectId} at ${member.path}`).join(", ") ?? combined.path;
        const notice = `Integration candidates ready at ${locations}. Delegate an independent tester without afterAgentId, then confirm_integration. Project branches are unchanged.`;
        session.agent.messages.push(message("system", notice, "notice"));
        this.publish();
        reply(true, JSON.stringify(session.agent.integration));
        return;
      }
      if (params.tool === confirmIntegrationTool.name) {
        if (session.agent.role !== "lead" || !session.agent.integration) throw new Error("Only a team lead with an integration candidate can confirm it.");
        const integration = session.agent.integration;
        const binding = { agentId: session.agent.id, submissionId: integration.id, fingerprint: integration.fingerprint };
        try { this.assertCheckCurrent(binding); }
        catch (error) {
          delete integration.confirmed;
          this.publish();
          throw error;
        }
        const testers = reports.filter((entry) => entry.agent.duty === "tester" && entry.agent.validationTargetId === session.agent.id &&
          (entry.agent.validationIntegrationId === integration.id ||
            (!integration.members && !entry.agent.validationIntegrationId && entry.agent.candidate?.path === integration.path)));
        if (testers.some((entry) => entry.run || entry.recovery || entry.waitingFor || entry.queue.length)) throw new Error("Wait for all scheduled integration testing to finish.");
        const latest = integration.validationEvidence ?? testers.filter((entry) => entry.agent.check?.submissionId === integration.id && entry.agent.check.targetAgentId === session.agent.id)
          .map((entry) => entry.agent.check!).sort((a, b) => b.recordedAt - a.recordedAt)[0];
        if (latest?.outcome !== "passed" || latest.candidateFingerprint !== integration.fingerprint) throw new Error("The combined snapshot needs a fresh passing integration tester report.");
        integration.confirmed = true;
        const notice = integration.members
          ? `The pinned snapshots passed joint testing. Review and approve merges separately for ${integration.members.map((member) => member.projectId).join(", ")}. Orchestra did not merge any repository.`
          : "The combined integration snapshot passed independent testing and is accepted. User approval is required before merging into the project branch; Orchestra has not merged it.";
        session.agent.messages.push(message("system", notice, "success"));
        this.sessions.get(coordinatorId)?.agent.messages.push(message("system", notice, "success", session.agent.id));
        this.publish();
        reply(true, notice);
        return;
      }
      if (params.tool === listTool.name) {
        reply(true, JSON.stringify(reports.map(({ agent }) => ({
          id: agent.id, projectId: agent.projectId, projectIds: agent.directCandidates?.map(({ projectId }) => projectId), teamId: agent.teamId, parentId: agent.parentId, name: agent.name, role: agent.role, duty: agent.duty, goal: agent.goal, status: agent.status,
          submissionId: agent.submissionId, acceptanceOwnerId: agent.acceptanceOwnerId, requiredChecks: agent.requiredChecks, validationTargetId: agent.validationTargetId, candidate: agent.candidate?.path, check: agent.check,
        }))));
        return;
      }
      const goal = typeof params.arguments?.goal === "string" ? params.arguments.goal.trim() : "";
      if (!goal || goal.length > 24_000) throw new Error("Provide a goal of up to 24,000 characters.");
      if (params.tool === relayTool.name) {
        if ((session.run!.reuseRequest || session.run!.reuseLookupAttempted) && !session.run!.message.reuseTeamId) {
          throw new Error("Resolve the requested archived team before sending assignments.");
        }
        const recipient = reports.find((entry) => entry.agent.id === params.arguments?.agentId);
        if (!recipient?.threadId) throw new Error("Choose an open descendant on your team.");
        this.checkCandidateAccess(recipient);
        const instruction = message("user", goal);
        const run = session.run!;
        const runId = run.message.orchestrationRunId ?? run.message.id;
        instruction.orchestrationRunId = runId;
        recipient.agent.messages.push(instruction);
        await this.enqueue(recipient, instruction);
        const outcome = this.delegationOutcome(recipient, instruction);
        if (outcome !== "failed") run.delegated = true;
        this.trackUsage((usage) => usage.recordDecision({
          id: instruction.id, at: Date.now(), agentId: session.agent.id, delegateId: recipient.agent.id,
          runId: instruction.orchestrationRunId, teamId: this.usageTeam(recipient.agent),
          duty: recipient.agent.duty ?? recipient.agent.role, reason: "Follow-up for an existing agent.",
          model: recipient.agent.modelSettings?.reportedModel, outcome,
        }));
        if (outcome !== "failed") this.signal(session.agent.id, recipient.agent.id);
        reply(outcome !== "failed", outcome === "failed" ? "The turn could not start." : "Instruction delivered.");
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
      if ((duty === "lead" && session.agent.role !== "coordinator") || (duty === "coder" && session.agent.role !== "lead" && session.agent.role !== "coordinator")) {
        throw new Error("Only the pilot can start leads. Only the pilot or a lead can assign coders.");
      }
      const reuseTeamId = session.run!.message.reuseTeamId;
      if ((session.run!.reuseRequest || session.run!.reuseLookupAttempted) && !reuseTeamId) {
        throw new Error("Resolve the requested archived team before delegating.");
      }
      const reusedTeam = reuseTeamId && this.teams.get(reuseTeamId);
      if (reuseTeamId && !reusedTeam) throw new Error("The selected team is no longer available.");
      const requestedProject = params.arguments?.projectId;
      const requestedProjects = params.arguments?.projectIds;
      const direct = duty === "coder" && requestedProjects !== undefined;
      if (requestedProjects !== undefined && ((duty !== "lead" && duty !== "coder") || session.agent.role !== "coordinator" ||
          !Array.isArray(requestedProjects) || !requestedProjects.length ||
          new Set(requestedProjects).size !== requestedProjects.length ||
          requestedProjects.some((id) => !this.projects.some((project) => project.id === id)))) {
        throw new Error("The pilot can specify distinct configured projectIds for a lead or direct coder.");
      }
      if (direct && (requestedProject !== undefined || requestedProjects.length < 2)) {
        throw new Error("Choose at least two repositories using projectIds alone for a direct multi-repo coder.");
      }
      if (reusedTeam && requestedProjects &&
          (requestedProjects.length !== reusedTeam.projectIds.length || requestedProjects.some((id) => !reusedTeam.projectIds.includes(id)))) {
        throw new Error("A reused team retains its existing repository assignments.");
      }
      const teamProjects = reusedTeam?.projectIds ?? requestedProjects;
      const checkDuty = duty === "tester" || duty === "reviewer" || duty === "designer";
      const after = params.arguments?.afterAgentId ?? (session.agent.duty === "coder" ? session.agent.id : undefined);
      const prerequisite = after === undefined ? undefined : session.agent.duty === "coder" && after === session.agent.id
        ? session : reports.find((entry) => entry.agent.id === after && entry.agent.duty === "coder");
      if (prerequisite?.agent.directCandidates) {
        throw new Error("Use a team lead when independent validation of a multi-repo change is needed.");
      }
      const integrationCheck = !prerequisite && checkDuty && session.agent.role === "lead" ? session.agent.integration : undefined;
      const anchorProject = integrationCheck?.members?.find((member) => member.path === integrationCheck.path)?.projectId;
      const inheritedProject = prerequisite?.agent.projectId ?? anchorProject;
      if (inheritedProject && requestedProject !== undefined && requestedProject !== inheritedProject) {
        throw new Error("Select a projectId for the validation target's assigned repository.");
      }
      const project = this.selectProject(session, requestedProject ?? inheritedProject ??
        (direct ? requestedProjects[0] : duty === "lead" || teamProjects?.length === 1 ? teamProjects?.[0] : undefined));
      if (teamProjects && !teamProjects.includes(project.id)) {
        throw new Error("Choose a project assigned to the selected team.");
      }
      const modelSettings = this.selectModelSettings(params.arguments?.complexity);
      const checkPlan = params.arguments?.requiredChecks;
      const requiredChecks = checkPlan === undefined ? [] : checkPlan;
      if ((duty !== "coder" && checkPlan !== undefined) ||
          !Array.isArray(requiredChecks) || new Set(requiredChecks).size !== requiredChecks.length ||
          requiredChecks.some((check) => check !== "reviewer" && check !== "tester")) {
        throw new Error("Specify unique reviewer or tester requirements only when assigning a coder.");
      }
      if (session.agent.duty === "coder" && !checkDuty) throw new Error("Coders may delegate only reviewer, tester, or designer checks for their own candidate.");
      if (after !== undefined && (!prerequisite || !checkDuty ||
          (!prerequisite.run && !coderIsReady(prerequisite.agent) && prerequisite.agent.status !== "working"))) {
        throw new Error("Schedule review, design review, or testing after an active or completed coder on your team.");
      }
      if (!prerequisite && (duty === "reviewer" || duty === "tester") && !integrationCheck) {
        throw new Error("Set afterAgentId to the coder to validate. A lead can also create an integration candidate first.");
      }
      if (direct && requiredChecks.length) {
        throw new Error("Use a team lead when independent validation of a multi-repo change is needed.");
      }
      const directCandidates: WorkspaceAgent["directCandidates"] = direct ? [] : undefined;
      if (directCandidates) {
        try {
          for (const projectId of requestedProjects) {
            const root = this.projects.find((entry) => entry.id === projectId)!.path;
            directCandidates.push({ projectId, ...createFeatureWorktree(root) });
          }
        } catch (error) {
          for (const { projectId, path } of directCandidates) {
            removeFeatureWorktree(this.projects.find((entry) => entry.id === projectId)!.path, path);
          }
          throw error;
        }
      }
      const candidate = duty === "coder" ? directCandidates?.[0] ?? createFeatureWorktree(project.path)
        : prerequisite?.agent.candidate ?? (integrationCheck ? { path: integrationCheck.path, base: integrationCheck.base } : session.agent.candidate);
      const parentId = prerequisite?.agent.id ?? session.agent.id;
      const agent = this.createAgent(randomUUID(), name, duty === "lead" ? "lead" : "worker", parentId, goal);
      agent.agent.projectId = project.id;
      agent.agent.teamId = reusedTeam ? reusedTeam.id : prerequisite?.agent.teamId ?? session.agent.teamId;
      agent.agent.duty = duty === "lead" ? undefined : duty;
      agent.agent.candidate = candidate;
      agent.agent.directCandidates = directCandidates;
      agent.agent.modelSettings = modelSettings;
      if (prerequisite || integrationCheck) agent.agent.validationTargetId = prerequisite?.agent.id ?? session.agent.id;
      agent.agent.validationIntegrationId = integrationCheck?.id;
      if (duty === "coder") {
        agent.agent.acceptanceOwnerId = session.agent.id;
        agent.agent.requiredChecks = requiredChecks;
        const notice = directCandidates
          ? `Feature worktrees for ${name}: ${directCandidates.map(({ projectId, path }) => `${projectId}: ${path}`).join(", ")}`
          : `Feature worktree for ${name}: ${candidate!.path}`;
        for (const recipient of new Set([session, this.sessions.get(coordinatorId)])) {
          recipient?.agent.messages.push(message("system", notice, "notice", agent.agent.id));
        }
      }
      try {
        if (!prerequisite || (!prerequisite.run && coderIsReady(prerequisite.agent))) this.checkCandidateAccess(agent);
      } catch (error) {
        this.sessions.delete(agent.agent.id);
        this.state.agents.pop();
        throw error;
      }
      if (prerequisite && (duty === "reviewer" || duty === "tester") && prerequisite.agent.requiredChecks &&
          !prerequisite.agent.requiredChecks.includes(duty)) {
        prerequisite.agent.requiredChecks.push(duty);
      }
      if (duty === "lead" && !agent.agent.teamId) {
        agent.agent.teamId = agent.agent.id;
        this.teams.set(agent.agent.id, { id: agent.agent.id, name, scope: goal.slice(0, 2000), projectIds: teamProjects ?? [project.id] });
      }
      const assignment = message("user", goal);
      assignment.reuseTeamId = reuseTeamId;
      const run = session.run!;
      assignment.orchestrationRunId = run.message.orchestrationRunId ?? run.message.id;
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
      const outcome = agent.agent.status === "error" ? "failed" : this.delegationOutcome(agent, assignment);
      if (outcome !== "failed") run.delegated = true;
      this.trackUsage((usage) => usage.recordDecision({
        id: assignment.id, at: Date.now(), agentId: session.agent.id, delegateId: agent.agent.id,
        runId: assignment.orchestrationRunId, teamId: this.usageTeam(agent.agent),
        duty, complexity: modelSettings.complexity, model: modelSettings.requestedModel, outcome,
        reason: reusedTeam && session.agent.role === "coordinator" ? "Fresh assignment for an explicitly selected team."
          : duty === "lead" ? "Lead for coordinated work."
          : duty === "coder" ? session.agent.role === "coordinator" ? "Direct assignment to a coder." : "Implementation in an isolated candidate."
          : prerequisite || integrationCheck ? "Independent candidate check." : "Specialist assignment.",
      }));
      if (outcome !== "failed") this.signal(session.agent.id, agent.agent.id);
      reply(outcome !== "failed", JSON.stringify({
        id: agent.agent.id, projectId: project.id, directCandidates, teamId: agent.agent.teamId, name, duty, modelSettings: agent.agent.modelSettings, waitingFor: agent.waitingFor, candidate: agent.agent.candidate?.path,
      }));
    } catch (error) {
      reply(false, errorText(error));
    }
  }

  private delegationOutcome(agent: AgentSession, assignment: WorkspaceMessage): NonNullable<DelegationDecision["outcome"]> {
    if (assignment.state === "failed") return "failed";
    if (assignment.state === "queued") return "queued";
    if (agent.run?.message === assignment && !agent.run.turn) return "uncertain";
    return "started";
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
