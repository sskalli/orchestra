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

async function claudeWorkspace(t: TestContext, scripts: Script[]) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-claude-"));
  const fake = fakeClaude(scripts);
  const store = workspaceStore(root, join(root, "state"), "engine:claude");
  let server!: ClaudeAppServer;
  const runtime = new WorkspaceRuntime({ cwd: root, engine: "claude", store,
    createServer: () => (server = new ClaudeAppServer(store.claudeJournalPath, fake.query as any)) });
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

test("Codex workspaces keep naming Codex in their messages", () => {
  const runtime = new WorkspaceRuntime({ cwd: tmpdir(), demo: true });
  assert.equal((runtime as any).engineName, "Codex");
  assert.equal(runtime.snapshot().provider.name, "codex");
});
