import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ClaudeAppServer } from "../src/claude-app-server.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

type Io = { options: any; nextUser: () => Promise<any>; interrupted: () => boolean };
type Script = (io: Io) => AsyncGenerator<any>;

/** Stands in for the Agent SDK query(): each turn runs the next script against the streamed prompt. */
function fakeClaude(scripts: Script[]) {
  const turns: Io[] = [];
  const query = ({ prompt, options }: { prompt: AsyncIterable<any>; options?: any }) => {
    const iterator = prompt[Symbol.asyncIterator]();
    let interrupted = false;
    const io: Io = { options, nextUser: async () => (await iterator.next()).value, interrupted: () => interrupted };
    turns.push(io);
    const script = scripts.shift();
    if (!script) throw new Error("No scripted Claude turn left.");
    return Object.assign(script(io), { interrupt: async () => { interrupted = true; } }) as any;
  };
  return { query, turns };
}

const reply = (id: string, text: string) => [
  { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
  { type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "text", text }] } },
];
const result = (answered: string[], usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }) =>
  ({ type: "result", subtype: "success", is_error: false, usage, user_message_uuids: answered });

async function until<T>(read: () => T | undefined | false, label: string) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function claudeWorkspace(t: TestContext, scripts: Script[], serverOptions: { wakeDelayMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-claude-"));
  const fake = fakeClaude(scripts);
  const store = workspaceStore(root, join(root, "state"), "engine:claude");
  let server!: ClaudeAppServer;
  const runtime = new WorkspaceRuntime({ cwd: root, engine: "claude", store,
    createServer: () => (server = new ClaudeAppServer(store.claudeJournalPath, fake.query as any, serverOptions)) });
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const agent = (id: string) => runtime.snapshot().agents.find((entry) => entry.id === id)!;
  return { root, runtime, fake, store, agent, server: () => server };
}

test("Claude turns stream replies, report usage, and resume the same Claude session", async (t) => {
  const { runtime, fake, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      assert.match(first.message.content, /Hello/);
      yield { type: "system", subtype: "init", model: "claude-opus-5-5" };
      yield* reply("m1", "Hi there");
      yield result([first.uuid]);
    },
    async function* (io) {
      const next = await io.nextUser();
      yield* reply("m2", "Again");
      yield result([next.uuid]);
    },
  ]);
  assert.equal(runtime.snapshot().provider.name, "claude");
  assert.equal(runtime.snapshot().provider.state, "ready");
  const agentId = String(await runtime.command({ type: "createTask", name: "Chat", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Hello" });
  await until(() => agent(agentId).status === "done", "the first turn");
  assert.deepEqual(agent(agentId).messages.filter(({ role }) => role === "assistant").map(({ text }) => text), ["Hi there"]);
  const [firstTurn] = fake.turns;
  assert.equal(typeof firstTurn.options.sessionId, "string");
  assert.equal(firstTurn.options.resume, undefined);
  assert.equal(firstTurn.options.permissionMode, "default");
  assert.equal(firstTurn.options.env.ANTHROPIC_API_KEY, undefined);
  assert.match(firstTurn.options.systemPrompt.append, /Work directly with the user/);
  assert.equal(runtime.snapshot().usage?.total.tokens?.inputTokens, 13);
  assert.equal(runtime.snapshot().usage?.total.tokens?.cachedInputTokens, 2);

  await runtime.command({ type: "send", agentId, text: "And again" });
  await until(() => agent(agentId).messages.some(({ text }) => text === "Again") && agent(agentId).status === "done", "the second turn");
  assert.equal(fake.turns[1].options.resume, firstTurn.options.sessionId);
  assert.equal(fake.turns[1].options.sessionId, undefined);
});

test("Claude permission prompts become approval cards and return the user's decision", async (t) => {
  let bashDecision: any;
  let writeDecision: any;
  let subagentDecision: any;
  const rule = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow" };
  // Claude Code usually suggests saving rules to the repo's local settings or switching mode; neither may outlast the task.
  const suggestions = [{ ...rule, destination: "localSettings" }, { type: "setMode", mode: "acceptEdits", destination: "session" }];
  const { runtime, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      const signal = new AbortController().signal;
      bashDecision = await io.options.canUseTool("Bash", { command: "npm test", description: "Run the tests" }, { signal, suggestions });
      writeDecision = await io.options.canUseTool("Write", { file_path: "/elsewhere/notes.md", content: "x" },
        { signal, blockedPath: "/elsewhere/notes.md" });
      subagentDecision = await io.options.canUseTool("Bash", { command: "rm -rf build" }, { signal, agentID: "agent-1" });
      assert.deepEqual(io.options.hooks.PreToolUse[0].matcher.split("|").sort(), ["Edit", "MultiEdit", "NotebookEdit", "Write"]);
      const hook = await io.options.hooks.PreToolUse[0].hooks[0]({}, "tool-1", { signal });
      assert.equal(hook.hookSpecificOutput.permissionDecision, "ask");
      yield result([first.uuid]);
    },
  ]);
  const agentId = String(await runtime.command({ type: "createTask", name: "Tests", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Run the tests" });
  const approvals = () => agent(agentId).messages.filter(({ commandApproval }) => commandApproval?.status === "pending");
  const command = await until(() => approvals()[0], "the command approval");
  assert.equal(command.commandApproval?.command, "npm test");
  assert.equal(command.commandApproval?.reason, "Run the tests");
  assert.deepEqual(command.commandApproval?.choices, ["approve", "approveForSession", "decline"]);
  await runtime.command({ type: "resolveCommandApproval", agentId, requestId: command.id, decision: "approveForSession" });
  const file = await until(() => approvals()[0], "the file approval");
  assert.equal(file.commandApproval?.kind, "fileChange");
  assert.deepEqual(file.commandApproval?.files, ["/elsewhere/notes.md"]);
  assert.deepEqual(file.commandApproval?.choices, ["approve", "decline"]);
  await runtime.command({ type: "resolveCommandApproval", agentId, requestId: file.id, decision: "decline" });
  await until(() => agent(agentId).status === "done", "the turn");
  assert.deepEqual(bashDecision, { behavior: "allow", updatedInput: { command: "npm test", description: "Run the tests" },
    updatedPermissions: [{ ...rule, destination: "session" }] });
  assert.equal(writeDecision.behavior, "deny");
  assert.equal(subagentDecision.behavior, "deny");
  assert.equal(agent(agentId).messages.filter(({ commandApproval }) => commandApproval).length, 2);
});

test("Claude subagents appear as native children and workspace tools reach the task", async (t) => {
  let server!: () => ClaudeAppServer;
  let toolText = "";
  const workspace = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield { type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-1",
        description: "Find the callers", subagent_type: "Explore" };
      yield { type: "assistant", parent_tool_use_id: "tool-1", message: { id: "c1", content: [{ type: "text", text: "Found three callers." }] } };
      yield { type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "tool-1", status: "completed", summary: "Done" };
      const threadId = [...(server() as any).toolDefinitions.keys()][0];
      const decide = (server() as any).toolDefinitions.get(threadId).find(({ name }: { name: string }) => name === "raise_product_decision");
      const outcome = await decide.handler({ question: "Terse or detailed notes?" }, {});
      toolText = outcome.content[0].text;
      yield result([first.uuid]);
    },
  ]);
  server = workspace.server;
  const { runtime, agent } = workspace;
  const agentId = String(await runtime.command({ type: "createTask", name: "Explore", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Who calls this?" });
  await until(() => agent(agentId).status !== "working" && agent(agentId).messages.some(({ productQuestion }) => productQuestion), "the turn");
  const child = runtime.snapshot().agents.find(({ parentId }) => parentId === agentId)!;
  assert.equal(child.name, "Find the callers");
  assert.equal(child.status, "done");
  assert.deepEqual(child.messages.map(({ text }) => text), ["Found three callers."]);
  assert.match(toolText, /questionId/);
});

test("steering keeps the turn open until Claude answers every message sent to it", async (t) => {
  let release!: () => void;
  const steered = new Promise<void>((resolve) => { release = resolve; });
  const { runtime, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield { type: "system", subtype: "init" };
      await steered;
      const steer = await io.nextUser();
      assert.equal(steer.priority, "now");
      yield* reply("m1", "Answering the first message");
      yield result([first.uuid]);
      yield* reply("m2", "Answering the steer");
      yield result([steer.uuid]);
    },
  ]);
  const agentId = String(await runtime.command({ type: "createTask", name: "Steer", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Start" });
  await until(() => agent(agentId).canSteer, "a steerable turn");
  await runtime.command({ type: "steer", agentId, text: "Also check the docs" });
  release();
  await until(() => agent(agentId).status === "done", "the turn");
  assert.deepEqual(agent(agentId).messages.filter(({ role }) => role === "assistant").map(({ text }) => text),
    ["Answering the first message", "Answering the steer"]);
});

const backgroundAgent = (toolUseId: string, description: string) =>
  ({ type: "system", subtype: "task_started", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, description,
    subagent_type: "general-purpose", is_backgrounded: true });
const agentDone = (toolUseId: string, summary: string) =>
  ({ type: "system", subtype: "task_notification", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, status: "completed", summary });

test("background subagents keep the turn open so the task can ask and hear answers while they run", async (t) => {
  let server!: () => ClaudeAppServer;
  let finishChild!: () => void;
  const childMayFinish = new Promise<void>((resolve) => { finishChild = resolve; });
  const workspace = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      assert.match(io.options.systemPrompt.append, /background subagents keep your turn open/);
      yield { type: "system", subtype: "init" };
      yield backgroundAgent("tool-1", "Implement map-shell");
      yield* reply("m1", "The implementer is running. One question first.");
      const threadId = [...(server() as any).toolDefinitions.keys()][0];
      const decide = (server() as any).toolDefinitions.get(threadId).find(({ name }: { name: string }) => name === "raise_product_decision");
      await decide.handler({ question: "Orchestra (2) or (2) Orchestra?" }, {});
      // Claude ends its response here; in Orchestra the turn must survive with the subagent still running.
      yield result([first.uuid]);
      const answer = await io.nextUser();
      assert.match(answer.message.content, /Answer: Orchestra \(2\)/);
      yield* reply("m2", "Noted, I'll tell the implementer.");
      yield result([answer.uuid]);
      const status = await io.nextUser();
      assert.equal(status.message.content, "How is it going?");
      yield* reply("m3", "Still implementing.");
      yield result([status.uuid]);
      await childMayFinish;
      yield { type: "assistant", parent_tool_use_id: "tool-1", message: { id: "c1", content: [{ type: "text", text: "Committed on exp1/map-shell." }] } };
      yield agentDone("tool-1", "Committed");
      // Claude Code resumes the parent on the task notification.
      yield* reply("m4", "map-shell is ready for review.");
      yield result([]);
    },
  ]);
  server = workspace.server;
  const { runtime, agent } = workspace;
  const agentId = String(await runtime.command({ type: "createTask", name: "Backlog", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Implement the backlog" });
  await until(() => agent(agentId).awaitingSubagents === 1, "the turn to wait for its subagent");
  assert.equal(agent(agentId).status, "working");
  const child = () => runtime.snapshot().agents.find(({ parentId }) => parentId === agentId)!;
  assert.equal(child().status, "working");

  const question = agent(agentId).messages.find(({ productQuestion }) => productQuestion?.status === "pending")!;
  await runtime.command({ type: "answerProductQuestion", agentId, questionId: question.id, text: "Orchestra (2)" });
  await until(() => agent(agentId).messages.some(({ text }) => text === "Noted, I'll tell the implementer."), "the answer to reach Claude");
  assert.equal(agent(agentId).messages.find(({ id }) => id === question.id)!.productQuestion!.status, "answered");
  assert.equal(agent(agentId).queueDepth, 0);

  await until(() => agent(agentId).awaitingSubagents === 1, "the turn to wait again");
  await runtime.command({ type: "send", agentId, text: "How is it going?" });
  await until(() => agent(agentId).messages.some(({ text }) => text === "Still implementing."), "the live reply");
  assert.equal(agent(agentId).queueDepth, 0);
  assert.equal(child().status, "working");

  finishChild();
  await until(() => agent(agentId).status === "done", "the turn to end after the subagent");
  assert.equal(child().status, "done");
  assert.equal(agent(agentId).awaitingSubagents, undefined);
  assert.ok(agent(agentId).messages.some(({ text }) => text === "map-shell is ready for review."));
});

test("a task left idle after its last background subagent is prompted to continue", async (t) => {
  const { runtime, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield backgroundAgent("tool-1", "Review the branch");
      yield* reply("m1", "Reviewer started.");
      yield result([first.uuid]);
      yield agentDone("tool-1", "No issues found");
      // This Claude Code does not resume the parent by itself.
      const wake = await io.nextUser();
      assert.match(wake.message.content, /background subagents have finished/);
      yield* reply("m2", "The review found no issues.");
      yield result([wake.uuid]);
    },
  ], { wakeDelayMs: 20 });
  const agentId = String(await runtime.command({ type: "createTask", name: "Review", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Review it" });
  await until(() => agent(agentId).status === "done", "the turn");
  assert.deepEqual(agent(agentId).messages.filter(({ role }) => role === "assistant").map(({ text }) => text),
    ["Reviewer started.", "The review found no issues."]);
});

test("Claude reporting idle with no background subagents left ends a waiting turn", async (t) => {
  const { runtime, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield backgroundAgent("tool-1", "Explore");
      yield result([first.uuid]);
      yield agentDone("tool-1", "Done");
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
      await new Promise(() => {});
    },
  ], { wakeDelayMs: 60_000 });
  const agentId = String(await runtime.command({ type: "createTask", name: "Idle", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Go" });
  await until(() => agent(agentId).status === "done", "the turn");
});

test("stopping a turn that waits for background subagents stops them too", async (t) => {
  const { runtime, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield backgroundAgent("tool-1", "Long job");
      yield result([first.uuid]);
      // Closing the input ends Claude Code, as stopping does for the real CLI.
      while (await io.nextUser()) { /* drain */ }
    },
  ]);
  const agentId = String(await runtime.command({ type: "createTask", name: "Stop waiting", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Go" });
  await until(() => agent(agentId).awaitingSubagents === 1, "the waiting turn");
  await runtime.command({ type: "cancel", agentId });
  await until(() => agent(agentId).status !== "working", "the stopped turn");
  assert.equal(agent(agentId).status, "idle");
  const child = runtime.snapshot().agents.find(({ parentId }) => parentId === agentId)!;
  assert.notEqual(child.status, "working");
});

test("a Claude turn left running by a stopped server is reported as interrupted", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-claude-journal-"));
  try {
    const path = join(root, "journal.json");
    writeFileSync(path, JSON.stringify({ version: 1, threads: [{ id: "thread-1", started: true,
      turns: [{ id: "turn-1", status: "inProgress", items: [] }] }] }));
    const server = new ClaudeAppServer(path, (() => { throw new Error("unused"); }) as any);
    return server.call<any>("thread/resume", { threadId: "thread-1", cwd: root }).then((resumed) => {
      assert.equal(resumed.thread.status.type, "idle");
      assert.equal(resumed.initialTurnsPage.data[0].status, "interrupted");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping a Claude turn ends it at the next result, even with unanswered steering", async (t) => {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  const { runtime, agent, fake } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield { type: "system", subtype: "init" };
      await stopped;
      assert.equal(io.interrupted(), true);
      yield { type: "result", subtype: "error_during_execution", is_error: true, usage: {}, user_message_uuids: [first.uuid], errors: [] };
    },
  ]);
  const agentId = String(await runtime.command({ type: "createTask", name: "Stop", projectIds: [] }));
  await runtime.command({ type: "send", agentId, text: "Start" });
  await until(() => agent(agentId).canSteer, "a steerable turn");
  await runtime.command({ type: "steer", agentId, text: "Then do more" });
  await runtime.command({ type: "cancel", agentId });
  release();
  await until(() => agent(agentId).status !== "working", "the stopped turn");
  assert.equal(agent(agentId).status, "idle");
  assert.equal(fake.turns.length, 1);
});

test("Claude lists its models for the picker and applies a task's model and effort from the next query", async (t) => {
  const { runtime, fake, agent } = await claudeWorkspace(t, [
    async function* (io) {
      const first = await io.nextUser();
      yield* reply("m1", "One");
      yield result([first.uuid]);
    },
    async function* (io) {
      const next = await io.nextUser();
      yield* reply("m2", "Two");
      yield result([next.uuid]);
    },
    async function* (io) {
      const next = await io.nextUser();
      yield* reply("m3", "Three");
      yield result([next.uuid]);
    },
  ]);
  const agentId = String(await runtime.command({ type: "createTask", name: "Chat", projectIds: [], effort: "low" }));
  await runtime.command({ type: "send", agentId, text: "Hello" });
  await until(() => agent(agentId).status === "done", "the first turn");
  assert.equal(fake.turns[0].options.model, undefined);
  assert.equal(fake.turns[0].options.effort, "low");

  await runtime.command({ type: "setModel", agentId, model: "sonnet", effort: "max" });
  await runtime.command({ type: "send", agentId, text: "Again" });
  await until(() => agent(agentId).messages.some(({ text }) => text === "Two") && agent(agentId).status === "done", "the second turn");
  assert.equal(fake.turns[1].options.model, "sonnet");
  assert.equal(fake.turns[1].options.effort, "max");

  // The "Default" row returns to Claude Code's default model.
  await runtime.command({ type: "setModel", agentId, model: null, effort: null });
  await runtime.command({ type: "send", agentId, text: "Once more" });
  await until(() => agent(agentId).messages.some(({ text }) => text === "Three") && agent(agentId).status === "done", "the third turn");
  assert.equal(fake.turns[2].options.model, undefined);
  assert.equal(fake.turns[2].options.effort, undefined);
});

test("the Claude engine answers model/list from the Agent SDK without sending a prompt", async () => {
  let prompted = false;
  let closed = false;
  const query = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    void (async () => { for await (const _ of prompt) prompted = true; })();
    return {
      supportedModels: async () => [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus",
          supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
        { value: "haiku", displayName: "Haiku", description: "Fast", supportsEffort: false, supportedEffortLevels: ["low"] },
      ],
      close: () => { closed = true; },
    } as any;
  };
  const server = new ClaudeAppServer(undefined, query as any);
  const listed = await server.call<{ data: any[]; nextCursor: null }>("model/list", {});
  assert.deepEqual(listed.data.map(({ id, model, isDefault, supportedReasoningEfforts }: any) =>
    [id, model, isDefault, supportedReasoningEfforts.map(({ reasoningEffort }: any) => reasoningEffort)]), [
    ["default", "", true, ["low", "high", "max"]],
    ["haiku", "haiku", false, []],
  ]);
  assert.equal(listed.nextCursor, null);
  assert.equal(closed, true);
  assert.equal(prompted, false);
  await server.close();
});

test("a failed Claude model list is remembered briefly instead of asking Claude Code again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-claude-models-"));
  let probes = 0;
  const query = () => {
    probes += 1;
    return { supportedModels: async () => { throw new Error("not signed in"); }, close() {} } as any;
  };
  const store = workspaceStore(root, join(root, "state"), "engine:claude");
  const runtime = new WorkspaceRuntime({ cwd: root, engine: "claude", store,
    createServer: () => new ClaudeAppServer(store.claudeJournalPath, query as any) });
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const [first, second] = await Promise.all([runtime.listModels(), runtime.listModels()]);
  assert.match(first.error ?? "", /not signed in/);
  assert.equal(first, second);
  await runtime.listModels();
  assert.equal(probes, 1);
});

test("Codex workspaces keep naming Codex in their messages", () => {
  const runtime = new WorkspaceRuntime({ cwd: tmpdir(), demo: true });
  assert.equal((runtime as any).engineName, "Codex");
  assert.equal(runtime.snapshot().provider.name, "codex");
});
