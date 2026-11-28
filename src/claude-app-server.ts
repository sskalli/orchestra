// Presents Claude Code sessions through the App Server protocol subset that WorkspaceRuntime uses.
// A thread is one Claude Code session; a turn is one query over a streamed input that also carries steering messages.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createSdkMcpServer, getSessionMessages, query as claudeQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, EffortLevel, HookCallback, ModelInfo, Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Event, Id, ProviderServer } from "./app-server.ts";
import { allowedHosts, explainApproval, toolCacheFolders } from "./claude-permissions.ts";

export const claudeProviderId = "claude-code";
const toolServerName = "orchestra";
const effortLevels = new Set<unknown>(["low", "medium", "high", "xhigh", "max"] satisfies EffortLevel[]);
const modelListTimeoutMs = 60_000;

/** Claude Code lists its default model as "default"; Orchestra then leaves the model unset. */
function claudeModel(model: unknown) {
  return typeof model === "string" && model && model !== "default" ? model : undefined;
}

const writeTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools that only read files, with the input field naming the file or folder they read. */
const readTools: Readonly<Record<string, string>> = { Read: "file_path", Glob: "path", Grep: "path" };

function insideRoot(root: string, path: string) {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";
type JournalItem = { id: string; type: "agentMessage"; text: string };
type JournalTurn = { id: string; status: TurnStatus; error?: { message: string }; items: JournalItem[] };
type Tokens = { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number;
  cacheWriteInputTokens: number; reasoningOutputTokens: number };
/**
 * A thread is one Claude Code session, whose ID is the thread ID unless a rewind to the first prompt started a new one.
 * After a rewind, `resumeAt` is the last kept session entry: the next query resumes there, dropping what followed.
 */
type JournalThread = { id: string; started: boolean; parentThreadId?: string; parentTurnId?: string; nickname?: string; role?: string;
  turns: JournalTurn[]; total?: Tokens; sessionId?: string; resumeAt?: string };
type SessionMessages = (sessionId: string) => Promise<{ uuid: string }[]>;
type ToolSpec = { name: string; description: string; inputSchema: JsonSchema };
type JsonSchema = { type?: string; enum?: string[]; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[] };
type ThreadConfig = { cwd: string; roots: string[]; instructions: string; tools: ToolSpec[]; model?: string; effort?: EffortLevel };
type Run = {
  threadId: string;
  turn: JournalTurn;
  query: Query;
  input: InputQueue;
  abort: AbortController;
  unanswered: Set<string>;
  interrupted: boolean;
  error?: string;
  streamItems: Map<string, { id: string; text: string; done: boolean }[]>;
  blockItems: Map<string, string>;
  children: Map<string, { threadId: string; turn: JournalTurn }>;
  requests: Set<Id>;
  finished: boolean;
  /** Claude ended its response while background subagents still run; the query stays open so they keep running. */
  waiting: boolean;
  /** The turn may write its repositories (a repository task), not a read-only general chat. */
  writeTurn: boolean;
  /** The folder each tool call runs in, by tool use ID, as Claude Code reports it to hooks. */
  toolFolders: Map<string, string>;
  /** Background agents' descriptions, by Claude Code's agent ID. */
  agentNames: Map<string, string>;
  wakeTimer?: ReturnType<typeof setTimeout>;
};
type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(value: SDKUserMessage) {
    this.values.push(value);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.closed) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function zodFor(schema: JsonSchema): z.ZodType {
  if (schema.enum?.length) return z.enum(schema.enum as [string, ...string[]]);
  if (schema.type === "string") return z.string();
  if (schema.type === "number" || schema.type === "integer") return z.number();
  if (schema.type === "boolean") return z.boolean();
  if (schema.type === "array") return z.array(schema.items ? zodFor(schema.items) : z.unknown());
  if (schema.type === "object") return z.object(zodShape(schema));
  return z.unknown();
}

function zodShape(schema: JsonSchema) {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) =>
    [key, required.has(key) ? zodFor(value) : zodFor(value).optional()]));
}

/** Keeps "allow for this task" grants in memory: no settings-file rules and no permission-mode changes. */
export function sessionGrants(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? []).filter((update) => update.type === "addRules" || update.type === "addDirectories")
    .map((update) => ({ ...update, destination: "session" as const }));
}

/** Sends edits back to Orchestra for approval in planning turns, even when a settings rule would allow them. */
const askBeforeEdits: HookCallback = async () => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
    permissionDecisionReason: "Orchestra asks before edits outside an approved implementation turn." },
});

function tokens(usage: Record<string, unknown> | undefined): Tokens {
  const read = (key: string) => typeof usage?.[key] === "number" ? usage[key] as number : 0;
  const cached = read("cache_read_input_tokens");
  const written = read("cache_creation_input_tokens");
  const input = read("input_tokens") + cached + written;
  const output = read("output_tokens");
  return { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output,
    cacheWriteInputTokens: written, reasoningOutputTokens: 0 };
}

function addTokens(total: Tokens | undefined, last: Tokens): Tokens {
  if (!total) return { ...last };
  return Object.fromEntries(Object.entries(last).map(([key, value]) =>
    [key, value + total[key as keyof Tokens]])) as Tokens;
}

/** Explains failures in terms the user can act on. */
export function claudeErrorText(kind: string | undefined, fallback: string) {
  if (kind === "authentication_failed" || /not logged in|please run \/login|invalid api key/i.test(fallback)) {
    return "Claude Code is not signed in. Run `claude`, type /login, then restart the workspace.";
  }
  if (kind === "rate_limit" || /usage limit|rate limit/i.test(fallback)) return `Claude usage limit reached. ${fallback}`.trim();
  if (kind === "billing_error") return "Claude reported a billing problem with this account.";
  return fallback;
}

/** Tells Claude how Orchestra keeps a turn open around background subagents. */
const backgroundSubagentInstructions = "\n\nIn Orchestra, background subagents keep your turn open. " +
  "You may end your response while they run, for example to ask the user a product question. " +
  "Each finished subagent resumes you, and user replies reach you as new messages in the same turn. " +
  "Only say subagents are running if you started them in this turn and have not seen them finish.";

/** How long to wait for Claude Code to resume the parent after its last background subagent finishes. */
const defaultWakeDelayMs = 20_000;
const wakePrompt = "All of your background subagents have finished. Review their results and continue the task.";

/**
 * Slash commands that change the Claude Code session or terminal Orchestra owns. They still run when typed,
 * but autocomplete does not offer them: /clear and /rename diverge from the task Orchestra tracks, model
 * settings belong to the task, and the rest only affect a terminal.
 */
const hiddenCommands = new Set(["clear", "rename", "resume", "exit", "model", "effort", "fast",
  "color", "focus", "heapdump", "statusline", "terminal-setup", "vim", "doctor", "reload-plugins", "workflow-launch-exec"]);
const skillListTimeoutMs = 30_000;

export class ClaudeAppServer implements ProviderServer {
  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;

  private readonly threads = new Map<string, JournalThread>();
  private readonly configs = new Map<string, ThreadConfig>();
  private readonly runs = new Map<string, Run>();
  private readonly pending = new Map<Id, (result: unknown) => void>();
  private nextRequest = 1;
  private closed = false;
  /** Commands the latest session reported as bound to a local terminal. */
  private terminalCommands = new Set<string>();

  private readonly journalPath?: string;
  private readonly query: QueryFunction;
  private readonly wakeDelayMs: number;
  /** Folders every turn may read without asking, such as files dropped into the composer. */
  private readonly readableRoots: string[];
  private readonly sessionMessages: SessionMessages;

  constructor(journalPath?: string, query: QueryFunction = claudeQuery,
    options: { wakeDelayMs?: number; readableRoots?: string[]; sessionMessages?: SessionMessages } = {}) {
    this.journalPath = journalPath;
    this.query = query;
    this.wakeDelayMs = options.wakeDelayMs ?? defaultWakeDelayMs;
    this.readableRoots = (options.readableRoots ?? []).filter(isAbsolute).map((root) => resolve(root));
    this.sessionMessages = options.sessionMessages ??
      ((sessionId) => getSessionMessages(sessionId, { includeSystemMessages: true }));
    this.load();
  }

  private load() {
    if (!this.journalPath) return;
    let saved: { version?: number; threads?: JournalThread[] };
    try {
      saved = JSON.parse(readFileSync(this.journalPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Orchestra could not read its Claude session journal.");
    }
    for (const thread of saved.threads ?? []) {
      // Claude Code runs as a child of this server, so a turn still marked running stopped with the previous server.
      for (const turn of thread.turns) {
        if (turn.status === "inProgress") {
          turn.status = "interrupted";
          turn.error = { message: "Orchestra stopped while this Claude turn was running." };
        }
      }
      this.threads.set(thread.id, thread);
    }
  }

  private save() {
    if (!this.journalPath) return;
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.journalPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, threads: [...this.threads.values()] }), { mode: 0o600 });
    renameSync(temporary, this.journalPath);
  }

  private emit(method: string, params: Event["params"]) {
    if (!this.closed) this.onEvent?.({ method, params });
  }

  private request(method: string, params: Event["params"], signal?: AbortSignal) {
    const id = `claude-request-${this.nextRequest++}`;
    return new Promise<any>((resolve, reject) => {
      const settle = (result: unknown) => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", aborted);
        resolve(result);
      };
      const aborted = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.emit("serverRequest/resolved", { threadId: params.threadId, requestId: id });
        reject(new Error("The request was withdrawn."));
      };
      if (signal?.aborted) return reject(new Error("The request was withdrawn."));
      signal?.addEventListener("abort", aborted, { once: true });
      this.pending.set(id, settle);
      this.runs.get(params.threadId ?? "")?.requests.add(id);
      if (!this.onRequest) return aborted();
      void this.onRequest({ id, method, params }).catch((error: Error) => this.onFailure?.(error));
    });
  }

  reply(id: Id, result: object) {
    const settle = this.pending.get(id);
    if (!settle) throw new Error("Claude is no longer waiting for this decision.");
    settle(result);
  }

  reject(id: Id, message: string) {
    this.pending.get(id)?.({ error: message });
  }

  notify() {}

  async call<T>(method: string, params: any): Promise<T> {
    if (this.closed) throw new Error("Claude connection closed");
    switch (method) {
      case "initialize": return {} as T;
      case "account/read": return { account: { type: "claude" } } as T;
      case "thread/start": return this.startThread(params) as T;
      case "thread/resume": return this.resumeThread(params) as T;
      case "thread/read": return this.readThread(params.threadId) as T;
      case "thread/revert": return this.revertThread(params) as T;
      case "turn/start": return this.startTurn(params) as T;
      case "turn/steer": return this.steer(params) as T;
      case "turn/interrupt": return this.interrupt(params) as T;
      case "skills/list": return this.listSkills(params) as T;
      case "model/list": return this.listModels() as T;
      default: throw new Error(`RPC -32601: ${method} is not supported by the Claude engine`);
    }
  }

  /** Asks Claude Code for its models without sending a prompt, and answers in the App Server `model/list` shape. */
  private async listModels() {
    const input = new InputQueue();
    const probe = this.query({ prompt: input, options: {
      cwd: process.cwd(), env: this.claudeEnvironment(), settingSources: ["user"],
      ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        probe.supportedModels(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out listing Claude models")), modelListTimeoutMs); }),
      ]);
      return { data: models.map((model: ModelInfo) => ({
        id: model.value,
        model: claudeModel(model.value) ?? "",
        displayName: model.displayName,
        description: model.description,
        isDefault: model.value === "default",
        ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
        supportedReasoningEfforts: (model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [])
          .map((reasoningEffort) => ({ reasoningEffort, description: "" })),
      })), nextCursor: null };
    } finally {
      clearTimeout(timer);
      input.close();
      probe.close?.();
    }
  }

  private configure(params: any): ThreadConfig {
    const roots: string[] = Array.isArray(params.runtimeWorkspaceRoots) ? params.runtimeWorkspaceRoots : [];
    return {
      cwd: params.cwd, roots, instructions: params.developerInstructions ?? "",
      tools: Array.isArray(params.dynamicTools) ? params.dynamicTools : this.configs.get(params.threadId)?.tools ?? [],
      model: claudeModel(params.model),
      effort: this.configs.get(params.threadId)?.effort,
    };
  }

  private claudeEnvironment() {
    const env = { ...process.env };
    // Use the Claude Code sign-in (the user's plan) rather than an API key from the shell.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }

  /** Lists skills and slash commands from a short-lived Claude Code process that never receives a prompt. */
  private async listSkills(params: any) {
    const cwds: string[] = Array.isArray(params?.cwds) && params.cwds.length ? params.cwds : [process.cwd()];
    const input = new InputQueue();
    const abort = new AbortController();
    const query = this.query({ prompt: input, options: {
      cwd: cwds[0],
      additionalDirectories: cwds.slice(1),
      settingSources: ["user", "project", "local"],
      ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
      abortController: abort,
      env: this.claudeEnvironment(),
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const commands = await Promise.race([
        query.supportedCommands(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude did not list its skills in time.")), skillListTimeoutMs); }),
      ]);
      const skills = commands.filter(({ name }) => !name.startsWith("_") && !hiddenCommands.has(name) && !this.terminalCommands.has(name))
        .map(({ name, description, argumentHint }) => ({ name, description, argumentHint, enabled: true }));
      return { data: [{ cwd: cwds[0], skills, errors: [] }] };
    } finally {
      clearTimeout(timer);
      input.close();
      abort.abort();
    }
  }

  private startThread(params: any) {
    const thread: JournalThread = { id: randomUUID(), started: false, turns: [] };
    this.threads.set(thread.id, thread);
    this.configs.set(thread.id, this.configure(params));
    this.save();
    return { thread: { id: thread.id }, modelProvider: claudeProviderId, model: claudeModel(params.model) };
  }

  private resumeThread(params: any) {
    const thread = this.threads.get(params.threadId);
    if (!thread || thread.parentThreadId) throw new Error("Claude has no saved session for this task.");
    const config = this.configure(params);
    config.tools = this.configs.get(thread.id)?.tools ?? params.dynamicTools ?? [];
    this.configs.set(thread.id, config);
    return { thread: { id: thread.id, status: { type: this.runs.has(thread.id) ? "active" : "idle" }, turns: thread.turns },
      initialTurnsPage: { data: thread.turns }, modelProvider: claudeProviderId, model: claudeModel(params.model) };
  }

  private readThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude has no saved transcript for this subagent.");
    const running = thread.turns.at(-1)?.status === "inProgress";
    return { thread: { id: thread.id, parentThreadId: thread.parentThreadId,
      status: { type: running ? "active" : "idle" }, turns: thread.turns } };
  }

  /**
   * Drops the turn that `beforeTurnId` started and every later turn from the conversation Claude resumes. A turn's ID
   * is the UUID of its prompt in the Claude Code session, so the next query resumes at the session entry before it.
   * Only the conversation is rewound; files the dropped turns changed stay as they are.
   */
  private async revertThread(params: any) {
    const thread = this.threads.get(params.threadId);
    if (!thread || thread.parentThreadId) throw new Error("Claude has no saved session for this task.");
    if (this.runs.has(thread.id)) throw new Error("Stop the running Claude turn before editing a message.");
    const prompt = typeof params.beforeTurnId === "string" ? params.beforeTurnId : "";
    let entries: { uuid: string }[];
    try {
      entries = thread.started ? await this.sessionMessages(thread.sessionId ?? thread.id) : [];
    } catch (error) {
      throw new Error(`Claude's saved session could not be read. ${error instanceof Error ? error.message : String(error)}`);
    }
    const index = entries.findIndex(({ uuid }) => uuid === prompt);
    if (index < 0) throw new Error("Claude's saved session does not contain this message, so it cannot be edited.");
    if (this.runs.has(thread.id)) throw new Error("Stop the running Claude turn before editing a message.");
    if (index === 0) {
      // Nothing before the first prompt is kept, so the next turn opens a new Claude Code session.
      thread.sessionId = randomUUID();
      thread.started = false;
      delete thread.resumeAt;
    } else {
      thread.resumeAt = entries[index - 1].uuid;
    }
    const kept = thread.turns.findIndex(({ id }) => id === prompt);
    if (kept >= 0) thread.turns = thread.turns.slice(0, kept);
    this.save();
    return { thread: { id: thread.id, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  }

  private userMessage(text: string, priority?: "now"): SDKUserMessage {
    return { type: "user", uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: text }, ...(priority ? { priority } : {}) } as SDKUserMessage;
  }

  private promptText(params: any) {
    const text = (params.input ?? []).filter((entry: any) => entry?.type === "text").map((entry: any) => entry.text).join("\n\n");
    const context = Object.values(params.additionalContext ?? {}) as { name?: string; value?: string }[];
    return text + context.map(({ name, value }) => `\n\n<${name}>\n${value}\n</${name}>`).join("");
  }

  /** Orchestra's workspace tools per thread, kept so tests can call a handler directly. */
  private readonly toolDefinitions = new Map<string, ReturnType<typeof tool>[]>();

  private toolServer(threadId: string, tools: ToolSpec[]) {
    const definitions = tools.map((spec) => tool(spec.name, spec.description, zodShape(spec.inputSchema), async (args) => {
        const run = this.runs.get(threadId);
        if (!run) return { content: [{ type: "text" as const, text: "This tool is unavailable for the current turn." }], isError: true };
        const result = await this.request("item/tool/call", {
          threadId, turnId: run.turn.id, tool: spec.name, arguments: args as Record<string, unknown>, namespace: null,
        });
        const text = (result?.contentItems ?? []).map((item: { text?: string }) => item.text ?? "").join("\n") || result?.error || "";
        return { content: [{ type: "text" as const, text }], isError: result?.success !== true };
      }));
    this.toolDefinitions.set(threadId, definitions);
    return createSdkMcpServer({ name: toolServerName, tools: definitions });
  }

  private startTurn(params: any) {
    const thread = this.threads.get(params.threadId);
    const config = this.configs.get(params.threadId);
    if (!thread || !config) throw new Error("Claude has no open session for this task.");
    if (this.runs.has(thread.id)) throw new Error("A Claude turn is already running for this task.");
    // A turn's model and effort stay with the session for later turns, as on Codex.
    if (params.model !== undefined) config.model = claudeModel(params.model);
    if (params.effort !== undefined) config.effort = effortLevels.has(params.effort) ? params.effort : undefined;
    const implementation = params.sandboxPolicy?.type === "workspaceWrite";
    const roots: string[] = Array.isArray(params.runtimeWorkspaceRoots) ? params.runtimeWorkspaceRoots : config.roots;
    // Writable roots can add folders beyond the repositories, such as their Git data or folders the user allowed.
    const writable: string[] = implementation && Array.isArray(params.sandboxPolicy?.writableRoots) ? params.sandboxPolicy.writableRoots : [];
    const cwd: string = params.cwd ?? config.cwd;
    const input = new InputQueue();
    const first = this.userMessage(this.promptText(params));
    input.push(first);
    const abort = new AbortController();
    // The prompt's session UUID names the turn, so a later rewind can find where the turn began.
    const turn: JournalTurn = { id: first.uuid!, status: "inProgress", items: [] };
    const env = this.claudeEnvironment();
    const session = thread.sessionId ?? thread.id;
    let run: Run | undefined;
    // Records the folder a command runs in, for its approval card.
    const recordFolder: HookCallback = async (hook, toolUseId) => {
      if (run && toolUseId && typeof hook.cwd === "string") run.toolFolders.set(toolUseId, hook.cwd);
      return { continue: true };
    };
    // A finished command may have committed, pushed or added a worktree, so Orchestra checks Git during the turn.
    const commandFinished: HookCallback = async (_hook, toolUseId) => {
      if (run && !run.finished) {
        if (toolUseId) run.toolFolders.delete(toolUseId);
        this.emit("item/completed", { threadId: run.threadId, turnId: run.turn.id, item: { id: toolUseId ?? randomUUID(), type: "commandExecution" } });
      }
      return { continue: true };
    };
    const options: Options = {
      cwd,
      additionalDirectories: [...new Set([...roots, ...writable])].filter((root) => root !== cwd),
      ...(thread.started ? { resume: session, ...(thread.resumeAt ? { resumeSessionAt: thread.resumeAt } : {}) } : { sessionId: session }),
      systemPrompt: { type: "preset", preset: "claude_code", append: config.instructions + backgroundSubagentInstructions },
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      permissionMode: implementation ? "acceptEdits" : "default",
      canUseTool: this.permissionHandler(thread.id),
      mcpServers: { [toolServerName]: this.toolServer(thread.id, config.tools) },
      allowedTools: config.tools.map(({ name }) => `mcp__${toolServerName}__${name}`),
      disallowedTools: ["AskUserQuestion"],
      includePartialMessages: true,
      // Load the user's Claude Code settings and CLAUDE.md, as the terminal does; the hook keeps planning turns from editing.
      settingSources: ["user", "project", "local"],
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [recordFolder] },
          ...(implementation ? [] : [{ matcher: [...writeTools].join("|"), hooks: [askBeforeEdits] }])],
        PostToolUse: [{ matcher: "Bash", hooks: [commandFinished] }],
        PostToolUseFailure: [{ matcher: "Bash", hooks: [commandFinished] }],
      },
      sandbox: {
        enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: implementation, allowUnsandboxedCommands: true,
        // Repository tasks may reach their Git remotes and package registries, and write tool caches such as ~/.npm.
        ...(implementation ? { network: { allowedDomains: allowedHosts(roots) }, filesystem: { allowWrite: toolCacheFolders() } } : {}),
      },
      ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
      abortController: abort,
      env,
      stderr: (data) => { stderr = (stderr + data).slice(-2000); },
    };
    let stderr = "";
    const active: Run = run = {
      threadId: thread.id, turn, query: this.query({ prompt: input, options }), input, abort,
      unanswered: new Set([first.uuid!]), interrupted: false, streamItems: new Map(), blockItems: new Map(),
      children: new Map(), requests: new Set(), finished: false, waiting: false,
      writeTurn: implementation, toolFolders: new Map(), agentNames: new Map(),
    };
    this.runs.set(thread.id, active);
    thread.turns = [...thread.turns.slice(-7), turn];
    const kept = new Set(thread.turns.map(({ id }) => id));
    for (const child of this.threads.values()) {
      if (child.parentThreadId === thread.id && !kept.has(child.parentTurnId ?? "")) this.threads.delete(child.id);
    }
    this.save();
    this.emit("turn/started", { threadId: thread.id, turn: { id: turn.id, rootTurnId: turn.id, status: "inProgress" } });
    void this.consume(active).catch((error) => this.finishTurn(active, "failed", claudeErrorText(undefined, stderr.trim() || String(error?.message ?? error))));
    return { turn: { id: turn.id, rootTurnId: turn.id, status: "inProgress" } };
  }

  private steer(params: any) {
    const run = this.runs.get(params.threadId);
    if (!run || run.turn.id !== params.expectedTurnId || run.finished) throw new Error("There is no active Claude turn to steer.");
    const next = this.userMessage(this.promptText(params), "now");
    run.unanswered.add(next.uuid!);
    this.resume(run);
    run.input.push(next);
    return {};
  }

  private async interrupt(params: any) {
    const run = this.runs.get(params.threadId);
    if (!run || run.turn.id !== params.turnId) throw new Error("There is no active Claude turn to stop.");
    await run.query.interrupt();
    run.interrupted = true;
    // Steering that Claude has not picked up yet must not run as a new turn after a stop.
    run.input.close();
    return {};
  }

  private permissionHandler(threadId: string): CanUseTool {
    return async (toolName, input, options) => {
      const run = this.runs.get(threadId);
      if (!run || run.finished) return { behavior: "deny", message: "The turn has ended." };
      if (toolName.startsWith(`mcp__${toolServerName}__`) && options.mcpServer?.source === "sdk") return { behavior: "allow", updatedInput: input };
      const readPath = Object.hasOwn(readTools, toolName) ? input[readTools[toolName]] : undefined;
      if (typeof readPath === "string" && isAbsolute(readPath) && !readPath.includes("\0") &&
          this.readableRoots.some((root) => insideRoot(root, resolve(readPath)))) {
        return { behavior: "allow", updatedInput: input };
      }
      // A repository task may write its repositories, and the sandbox keeps a command to those folders and its allowed
      // hosts, so a sandboxed command runs even when Claude Code cannot analyse it (variables, loops, inline scripts).
      if (toolName === "Bash" && run.writeTurn && input.dangerouslyDisableSandbox !== true) return { behavior: "allow", updatedInput: input };
      const grants = sessionGrants(options.suggestions);
      const decisions = ["accept", ...(grants.length ? ["acceptForSession"] : []), "decline"];
      const itemId = randomUUID();
      const base = { threadId, turnId: run.turn.id, itemId, startedAtMs: Date.now() };
      // A background agent's request goes to the task's own approval card, naming the agent.
      const requestedBy = options.agentID ? run.agentNames.get(options.agentID) ?? "" : undefined;
      const { summary, reason, host } = explainApproval({ toolName, input, writeTurn: run.writeTurn,
        decisionReason: options.decisionReason, blockedPath: options.blockedPath, title: options.title,
        description: options.description, requestedBy });
      let method: string;
      let params: Event["params"];
      if (writeTools.has(toolName)) {
        const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
        this.emit("item/started", { threadId, turnId: run.turn.id,
          item: { id: itemId, type: "fileChange", changes: path ? [{ path }] : [] } });
        method = "item/fileChange/requestApproval";
        params = { ...base, summary, reason, ...(requestedBy !== undefined ? { requestedBy: requestedBy || "Background agent" } : {}), availableDecisions: decisions };
      } else {
        const command = host ? `Connect to ${host}` : toolName === "Bash" && typeof input.command === "string" ? input.command
          : toolName === "WebFetch" && typeof input.url === "string" ? `Fetch ${input.url}`
          : toolName === "WebSearch" && typeof input.query === "string" ? `Search the web for ${input.query}`
          : `${toolName} ${JSON.stringify(input)}`;
        method = "item/commandExecution/requestApproval";
        // The folder the command runs in, which the agent may have changed to one of its worktrees.
        const cwd = run.toolFolders.get(options.toolUseID) ?? this.configs.get(threadId)?.cwd;
        params = { ...base, command, cwd, summary, reason, ...(requestedBy !== undefined ? { requestedBy: requestedBy || "Background agent" } : {}),
          ...(host ? { networkApprovalContext: { host } } : {}), availableDecisions: decisions };
      }
      let response: { decision?: unknown };
      try {
        response = await this.request(method, params, options.signal);
      } catch {
        return { behavior: "deny", message: "The approval request was withdrawn." };
      }
      return this.permissionResult(response?.decision, input, grants);
    };
  }

  private permissionResult(decision: unknown, input: Record<string, unknown>, grants: PermissionUpdate[]): PermissionResult {
    if (decision === "accept") return { behavior: "allow", updatedInput: input };
    if (decision === "acceptForSession" && grants.length) return { behavior: "allow", updatedInput: input, updatedPermissions: grants };
    if (decision === "cancel") return { behavior: "deny", message: "The user declined this request and stopped the turn.", interrupt: true };
    return { behavior: "deny", message: "The user declined this request." };
  }

  private childFor(run: Run, toolUseId: string | null | undefined) {
    return toolUseId ? run.children.get(toolUseId) : undefined;
  }

  private completeText(run: Run, threadId: string, turn: JournalTurn, id: string, text: string) {
    const existing = turn.items.find((item) => item.id === id);
    if (existing) existing.text = text;
    else turn.items.push({ id, type: "agentMessage", text });
    this.emit("item/completed", { threadId, turnId: turn.id, item: { id, type: "agentMessage", text } });
  }

  private async consume(run: Run) {
    for await (const message of run.query as AsyncIterable<SDKMessage>) {
      if (run.finished) break;
      this.handle(run, message as any);
      if (run.finished) break;
    }
    if (!run.finished) {
      this.finishTurn(run, run.interrupted ? "interrupted" : "failed", run.error ?? "Claude ended the turn without a result.");
    }
  }

  private runningChildren(run: Run) {
    return [...run.children.values()].filter(({ turn }) => turn.status === "inProgress").length;
  }

  /** Keeps the turn open while background subagents run, and tells Orchestra the parent is waiting for them. */
  private wait(run: Run) {
    run.waiting = true;
    this.emit("turn/waiting", { threadId: run.threadId, turnId: run.turn.id, subagents: this.runningChildren(run) } as Event["params"]);
  }

  private resume(run: Run) {
    if (run.wakeTimer) clearTimeout(run.wakeTimer);
    run.wakeTimer = undefined;
    if (!run.waiting) return;
    run.waiting = false;
    this.emit("turn/waiting", { threadId: run.threadId, turnId: run.turn.id, subagents: 0 } as Event["params"]);
  }

  /** Claude Code normally resumes the parent when a background subagent finishes; if it stays idle, prompt it once. */
  private scheduleWake(run: Run) {
    if (run.wakeTimer) clearTimeout(run.wakeTimer);
    run.wakeTimer = setTimeout(() => {
      run.wakeTimer = undefined;
      if (run.finished || !run.waiting || this.runningChildren(run)) return;
      const wake = this.userMessage(wakePrompt);
      run.unanswered.add(wake.uuid!);
      this.resume(run);
      run.input.push(wake);
    }, this.wakeDelayMs);
    run.wakeTimer.unref?.();
  }

  private handle(run: Run, message: any) {
    const thread = this.threads.get(run.threadId)!;
    if ((message.type === "stream_event" || message.type === "assistant") && !message.parent_tool_use_id) this.resume(run);
    if (message.type === "system" && message.subtype === "session_state_changed") {
      // Claude Code reports idle once every result is out and no background agent remains.
      if (message.state === "idle" && run.waiting && !this.runningChildren(run) && !run.unanswered.size) this.finishTurn(run, "completed");
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      if (Array.isArray(message.terminal_slash_commands)) this.terminalCommands = new Set(message.terminal_slash_commands);
      // Once the session has loaded, new entries follow the rewind point, so later queries resume normally.
      if (!thread.started || thread.resumeAt) {
        thread.started = true;
        delete thread.resumeAt;
        this.save();
      }
      return;
    }
    if (message.type === "system" && message.subtype === "task_started" && message.tool_use_id &&
        (message.subagent_type || /agent/i.test(message.task_type ?? ""))) {
      if (message.task_id && message.description) run.agentNames.set(message.task_id, message.description);
      if (run.children.has(message.tool_use_id)) return;
      const child: JournalThread = { id: randomUUID(), started: true, parentThreadId: run.threadId, parentTurnId: run.turn.id,
        nickname: message.description, role: message.subagent_type, turns: [] };
      const turn: JournalTurn = { id: randomUUID(), status: "inProgress", items: [] };
      child.turns.push(turn);
      this.threads.set(child.id, child);
      run.children.set(message.tool_use_id, { threadId: child.id, turn });
      this.save();
      this.emit("thread/started", { thread: { id: child.id, parentThreadId: run.threadId,
        agentNickname: message.description ?? null, agentRole: message.subagent_type ?? null } });
      this.emit("turn/started", { threadId: child.id, turn: { id: turn.id, rootTurnId: turn.id, status: "inProgress" } });
      return;
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      const child = this.childFor(run, message.tool_use_id);
      if (!child || child.turn.status !== "inProgress") return;
      child.turn.status = message.status === "completed" ? "completed" : message.status === "stopped" ? "interrupted" : "failed";
      if (message.summary && !child.turn.items.length) this.completeText(run, child.threadId, child.turn, randomUUID(), message.summary);
      this.save();
      this.emit("turn/completed", { threadId: child.threadId, turn: { id: child.turn.id, rootTurnId: child.turn.id, status: child.turn.status } });
      if (run.waiting) {
        if (this.runningChildren(run)) this.wait(run);
        else this.scheduleWake(run);
      }
      return;
    }
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event;
      if (event?.type === "message_start") run.blockItems.set("current", event.message?.id ?? randomUUID());
      const messageId = run.blockItems.get("current") ?? "message";
      if (event?.type === "content_block_start" && event.content_block?.type === "text") {
        const id = `${messageId}:${event.index}`;
        run.blockItems.set(`${messageId}:${event.index}`, id);
        const items = run.streamItems.get(messageId) ?? [];
        items.push({ id, text: "", done: false });
        run.streamItems.set(messageId, items);
      }
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const id = run.blockItems.get(`${messageId}:${event.index}`);
        if (!id) return;
        const item = run.streamItems.get(messageId)?.find((entry) => entry.id === id);
        if (item) item.text += event.delta.text;
        this.emit("item/agentMessage/delta", { threadId: run.threadId, turnId: run.turn.id, itemId: id, delta: event.delta.text } as Event["params"]);
      }
      return;
    }
    if (message.type === "assistant") {
      if (message.error) run.error = claudeErrorText(message.error, (message.message?.content ?? [])
        .filter((block: any) => block.type === "text").map((block: any) => block.text).join(" ") || message.error);
      if (message.error === "authentication_failed" || message.error === "rate_limit") {
        this.emit("error", { threadId: run.threadId, turnId: run.turn.id, error: { message: run.error! }, willRetry: false });
      }
      const child = this.childFor(run, message.parent_tool_use_id);
      if (message.parent_tool_use_id && !child) return;
      for (const block of message.message?.content ?? []) {
        if (block.type !== "text" || !block.text) continue;
        if (child) {
          this.completeText(run, child.threadId, child.turn, `${message.message.id}:${randomUUID()}`, block.text);
          continue;
        }
        // Claude Code emits completed text blocks in order, so each one finishes the oldest open streamed block.
        const streamed = run.streamItems.get(message.message.id)?.find((entry) => !entry.done);
        if (streamed) streamed.done = true;
        this.completeText(run, run.threadId, run.turn, streamed?.id ?? `${message.message.id}:${randomUUID()}`, block.text);
      }
      return;
    }
    if (message.type === "result") {
      const last = tokens(message.usage);
      thread.total = addTokens(thread.total, last);
      this.emit("thread/tokenUsage/updated", { threadId: run.threadId, turnId: run.turn.id,
        tokenUsage: { total: thread.total, last } });
      const answered: string[] = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [...run.unanswered]);
      for (const id of answered) run.unanswered.delete(id);
      if (run.unanswered.size && !run.interrupted) return;
      if (run.interrupted) this.finishTurn(run, "interrupted", "The turn was interrupted.");
      else if (message.subtype === "success" && !message.is_error && this.runningChildren(run)) this.wait(run);
      else if (message.subtype === "success" && !message.is_error) this.finishTurn(run, "completed");
      else {
        const detail = (message.errors ?? []).join(" ") || (typeof message.result === "string" ? message.result : "") || run.error || "Claude could not complete the turn.";
        this.finishTurn(run, "failed", claudeErrorText(undefined, detail));
      }
    }
  }

  private finishTurn(run: Run, status: Exclude<TurnStatus, "inProgress">, error?: string) {
    if (run.finished) return;
    run.finished = true;
    if (run.wakeTimer) clearTimeout(run.wakeTimer);
    run.input.close();
    this.runs.delete(run.threadId);
    this.toolDefinitions.delete(run.threadId);
    run.turn.status = status;
    if (error && status !== "completed") run.turn.error = { message: error };
    for (const child of run.children.values()) {
      if (child.turn.status !== "inProgress") continue;
      child.turn.status = "interrupted";
      this.emit("turn/completed", { threadId: child.threadId, turn: { id: child.turn.id, rootTurnId: child.turn.id, status: "interrupted" } });
    }
    for (const id of run.requests) {
      const settle = this.pending.get(id);
      if (!settle) continue;
      settle({ decision: "decline", success: false, contentItems: [] });
      this.emit("serverRequest/resolved", { threadId: run.threadId, requestId: id });
    }
    this.save();
    this.emit("turn/completed", { threadId: run.threadId, turn: { id: run.turn.id, rootTurnId: run.turn.id, status,
      ...(run.turn.error ? { error: run.turn.error } : {}) } });
  }

  async close() {
    this.closed = true;
    for (const run of this.runs.values()) {
      run.abort.abort();
      run.input.close();
    }
    this.runs.clear();
  }
}
