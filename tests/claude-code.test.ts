import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkClaudeCode, ClaudeCodeError, runClaudeCode } from "../src/claude-code.ts";
import { WorkspaceRuntime, type WorkspaceAgent } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

function fixture(context: TestContext, script: string, loggedIn = true) {
  const cwd = mkdtempSync(join(tmpdir(), "orchestra-claude-test-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  const executable = join(cwd, "fake claude");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: ${loggedIn} }));
  process.exit(${loggedIn ? 0 : 1});
}
assert.equal(process.cwd(), ${JSON.stringify(cwd)});
const sessionId = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
const send = (event) => console.log(JSON.stringify(event));
const init = () => send({ type: "system", subtype: "init", session_id: sessionId });
const result = (properties = {}) =>
  send({ type: "result", subtype: "success", is_error: false, session_id: sessionId, ...properties });
const delta = (text) =>
  send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
${script}
`, { mode: 0o700 });
  return { executable, cwd, sessionId: randomUUID() };
}

test("Claude Code streams text once and places the prompt on stdin", { timeout: 5000 }, async (context) => {
  const options = fixture(context, `
assert(args.includes("--print") || args.includes("-p"));
assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
assert(args.includes("--include-partial-messages"));
assert(args.includes("--session-id"));
assert(!args.includes("--dangerously-skip-permissions"));
assert(!args.some((arg) => arg.includes("literal prompt")));
assert.equal(fs.readFileSync(0, "utf8").trimEnd(), "literal prompt\\n$(not a shell command)");
init();
const partial = (event) => JSON.stringify({ type: "stream_event", event }) + "\\n";
send({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", content: [] } } });
send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
const first = partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } });
process.stdout.write(first.slice(0, 15));
setTimeout(() => {
  process.stdout.write(first.slice(15));
  send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "世界!" } } });
  send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  send({ type: "stream_event", event: { type: "message_stop" } });
  send({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Hello, 世界!" }] } });
  result({ result: "Hello, 世界!" });
}, 30);
`);
  const chunks: string[] = [];
  let sessions = 0;
  const run = runClaudeCode({
    ...options,
    prompt: "literal prompt\n$(not a shell command)",
    onText: (chunk) => chunks.push(chunk),
    onSession: () => sessions++,
  });
  await run.completion;
  assert.deepEqual(chunks, ["Hello, ", "世界!"]);
  assert.equal(sessions, 1);
});

test("Claude Code resumes an explicit session and accepts complete assistant messages", { timeout: 5000 }, async (context) => {
  const options = fixture(context, `
assert(args.includes("--resume"));
assert(!args.includes("--session-id"));
assert.equal(sessionId, fs.readFileSync("session", "utf8"));
fs.readFileSync(0);
init();
send({ type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "Follow-up." }] } });
result({ result: "Follow-up." });
`);
  writeFileSync(join(options.cwd, "session"), options.sessionId);
  const chunks: string[] = [];
  await runClaudeCode({
    ...options, resume: true, prompt: "Continue", onText: (chunk) => chunks.push(chunk),
  }).completion;
  assert.equal(chunks.join(""), "Follow-up.");
});

test("Claude Code rejects missing, failed, malformed, and mismatched results", { timeout: 5000 }, async (context) => {
  const outcomes = [
    ["", /without a successful result/],
    [`result({ subtype: "error_during_execution", is_error: true, errors: ["Fixture failure"] });`, /Fixture failure/],
    [`console.log("{invalid json");`, /invalid streaming JSON/],
    [`result({ session_id: "different session" });`, /different session ID/],
  ] as const;
  for (const [output, diagnostic] of outcomes) {
    const options = fixture(context, `fs.readFileSync(0); init(); ${output}`);
    await assert.rejects(runClaudeCode({ ...options, prompt: "test", onText: () => {} }).completion,
      (error) => error instanceof ClaudeCodeError && error.kind === "failed" && diagnostic.test(error.message));
  }
});

test("Claude Code reports an executable that fails to launch", { timeout: 5000 }, async (context) => {
  const options = fixture(context, "");
  await assert.rejects(runClaudeCode({
    ...options, executable: join(options.cwd, "missing"), prompt: "test", onText: () => {},
  }).completion, (error) => error instanceof ClaudeCodeError && error.kind === "failed");
});

test("Claude Code detects signed-out status during preflight", { timeout: 5000 }, async (context) => {
  const { cwd, executable } = fixture(context, "", false);
  await assert.rejects(checkClaudeCode(cwd, executable),
    (error) => error instanceof ClaudeCodeError && error.kind === "signed-out");
});

test("Claude Code classifies a rate-limited assistant response", { timeout: 5000 }, async (context) => {
  const options = fixture(context, `
fs.readFileSync(0);
init();
send({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "Fixture limit" }] } });
result({ subtype: "error_during_execution", is_error: true });
`);
  const chunks: string[] = [];
  await assert.rejects(runClaudeCode({
    ...options, prompt: "test", onText: (chunk) => chunks.push(chunk),
  }).completion, (error) => error instanceof ClaudeCodeError && error.kind === "usage-limit");
  assert.deepEqual(chunks, []);
});

test("Claude Code cancels a running subprocess", { timeout: 5000 }, async (context) => {
  const options = fixture(context, `
fs.readFileSync(0);
setInterval(() => {}, 1000);
init();
delta("Running");
`);
  const run = runClaudeCode({
    ...options, prompt: "test", onText: () => run.cancel(),
  });
  context.after(() => run.cancel());
  await assert.rejects(run.completion,
    (error) => error instanceof ClaudeCodeError && error.kind === "cancelled");
});

test("Claude Code cancellation closes inherited output pipes", { timeout: 5000 }, async (context) => {
  const options = fixture(context, `
fs.readFileSync(0);
const helper = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 7000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
fs.writeFileSync("helper-pid", String(helper.pid));
helper.unref();
delta("Running");
`);
  const run = runClaudeCode({ ...options, prompt: "test", onText: () => run.cancel() });
  try {
    await assert.rejects(run.completion,
      (error) => error instanceof ClaudeCodeError && error.kind === "cancelled");
  } finally {
    try {
      process.kill(Number(readFileSync(join(options.cwd, "helper-pid"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
});

async function waitForCoordinator(runtime: WorkspaceRuntime, matches: (agent: WorkspaceAgent) => boolean) {
  const current = runtime.snapshot().agents[0];
  if (matches(current)) return current;
  return new Promise<WorkspaceAgent>((resolve, reject) => {
    const unsubscribe = runtime.subscribe(({ agents }) => {
      if (!matches(agents[0])) return;
      unsubscribe();
      clearTimeout(timeout);
      resolve(agents[0]);
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Coordinator did not reach the expected state: ${JSON.stringify(runtime.snapshot())}`));
    }, 2000);
  });
}

test("Claude workspace pauses queued input on cancel and resumes a saved session after restart", { timeout: 10000 }, async (context) => {
  const { cwd, executable } = fixture(context, `
const prompt = fs.readFileSync(0, "utf8");
init();
if (prompt.includes("Hold this turn")) {
  assert(args.includes("--resume"));
  assert.equal(sessionId, fs.readFileSync("session", "utf8"));
  setInterval(() => {}, 1000);
  delta("Holding");
} else if (prompt.includes("Queued follow-up")) {
  assert(args.includes("--resume"));
  assert.equal(sessionId, fs.readFileSync("session", "utf8"));
  send({ type: "assistant", message: { id: "last", content: [{ type: "text", text: "Resumed queued follow-up" }] } });
  result({ result: "Resumed queued follow-up" });
} else {
  assert(prompt.includes("Start a session"));
  assert(args.includes("--session-id"));
  fs.writeFileSync("session", sessionId);
  delta("Initial response");
  result({ result: "Initial response" });
}
`);
  const stateDir = join(cwd, "state");
  const store = workspaceStore(cwd, stateDir, "claude");
  const options = { cwd, provider: "claude" as const, store, claudeExecutable: executable };
  const runtime = new WorkspaceRuntime(options);
  context.after(() => runtime.close());
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready");
  const send = (text: string) => runtime.command({ type: "send", agentId: "coordinator", text });
  await send("Start a session");
  await waitForCoordinator(runtime, (agent) => agent.status === "done" &&
    agent.messages.some((message) => message.text === "Initial response"));
  await send("Hold this turn");
  await waitForCoordinator(runtime, (agent) => agent.messages.some((message) => message.text === "Holding"));
  await send("Queued follow-up");
  assert.equal(runtime.snapshot().agents[0].queueDepth, 1);
  await runtime.command({ type: "cancel", agentId: "coordinator" });
  const cancelled = await waitForCoordinator(runtime, (agent) => agent.queuePaused === true && agent.status === "idle");
  assert.deepEqual(cancelled.messages.filter((message) => message.state === "cancelled").map((message) => message.text),
    ["Hold this turn", "Holding"]);
  await runtime.close();
  assert.equal(workspaceStore(cwd, stateDir).load(), undefined);

  const restarted = new WorkspaceRuntime(options);
  context.after(() => restarted.close());
  await restarted.start();
  const [coordinator] = restarted.snapshot().agents;
  assert.equal(coordinator.queueDepth, 1);
  assert.equal(coordinator.queuePaused, true);
  assert.equal(coordinator.canSteer, false);
  await restarted.command({ type: "resumeQueue", agentId: "coordinator" });
  await waitForCoordinator(restarted, (agent) => agent.queueDepth === 0 && agent.status === "done" &&
    agent.messages.some((message) => message.text === "Resumed queued follow-up"));
});
