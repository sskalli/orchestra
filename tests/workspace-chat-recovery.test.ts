import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Event, Id, ProviderServer } from "../src/app-server.ts";
import { implementationApprovalText, messageCharacterLimit, messageLength, messageLengthProblem, retryableMessageId } from "../src/workspace-chat-recovery.ts";
import { WorkspaceRuntime, type WorkspaceMessage } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

type Script = "ok" | "rate-limit" | "retried-rate-limit" | "network-failure" | "slow-fail";

/** A scripted stand-in for Codex App Server. Error payloads match what Codex 0.166 sends for a provider 429. */
class FakeAppServer implements ProviderServer {
  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;
  scripts: Script[] = [];
  inputs: string[] = [];
  private turns = 0;

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "initialize") return {} as T;
    if (method === "account/read") return { account: { type: "chatgpt" } } as T;
    if (method === "thread/start") return { thread: { id: "thread-1" }, modelProvider: "openai", model: "gpt-test" } as T;
    if (method === "turn/start") {
      const turn = { id: `turn-${++this.turns}`, rootTurnId: null, status: "inProgress" };
      this.inputs.push((params.input as { text: string }[])[0].text);
      const script = this.scripts.shift() ?? "ok";
      setTimeout(() => this.play(script, turn.id), 5);
      return { turn } as T;
    }
    throw new Error(`Unexpected ${method}`);
  }

  private emit(method: string, params: Record<string, unknown>) {
    this.onEvent?.({ method, params: { threadId: "thread-1", ...params } } as Event);
  }

  private play(script: Script, turnId: string) {
    const tooMany = { message: "exceeded retry limit, last status: 429 Too Many Requests",
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } };
    const retrying429 = { message: "Reconnecting... 1/1", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } },
      additionalDetails: "exceeded retry limit, last status: 429 Too Many Requests" };
    const fail = (error: { message: string }) =>
      this.emit("turn/completed", { turn: { id: turnId, rootTurnId: null, status: "failed", error } });
    const complete = () => {
      this.emit("item/agentMessage/delta", { turnId, itemId: `reply-${turnId}`, delta: "Done." });
      this.emit("turn/completed", { turn: { id: turnId, rootTurnId: null, status: "completed" } });
    };
    this.emit("turn/started", { turn: { id: turnId, rootTurnId: null, status: "inProgress" } });
    if (script === "ok") complete();
    if (script === "rate-limit") {
      this.emit("error", { turnId, error: retrying429, willRetry: true });
      this.emit("error", { turnId, error: tooMany, willRetry: false });
      fail(tooMany);
    }
    if (script === "retried-rate-limit") {
      this.emit("error", { turnId, error: retrying429, willRetry: true });
      complete();
    }
    if (script === "network-failure") {
      const reconnecting = { message: "Reconnecting... waiting for network",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } };
      this.emit("error", { turnId, error: reconnecting, willRetry: true });
      fail({ message: "stream disconnected before completion" });
    }
    if (script === "slow-fail") setTimeout(() => fail({ message: "The model rejected the request." }), 80);
  }

  notify() {}
  reply() {}
  reject() {}
  async close() {}
}

async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the fake provider.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const project = mkdtempSync(join(tmpdir(), "orchestra-recovery-"));
  const fake = new FakeAppServer();
  const runtime = new WorkspaceRuntime({ cwd: project, store: workspaceStore(project, join(project, "state")), createServer: () => fake });
  t.after(async () => {
    await runtime.close();
    rmSync(project, { recursive: true, force: true });
  });
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready");
  const agentId = String(await runtime.command({ type: "createTask", name: "Recovery", projectIds: [] }));
  const task = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!;
  const settled = () => waitFor(() => task().status !== "working" && !task().canCancel);
  const send = async (text: string) => {
    await runtime.command({ type: "send", agentId, text });
    await settled();
  };
  return { runtime, fake, agentId, task, send };
}

test("a provider rate limit leaves the task usable and clears after the next successful turn", async (t) => {
  const { runtime, fake, task, send } = await setup(t);
  fake.scripts = ["rate-limit"];
  await send("Summarize the release.");
  const provider = runtime.snapshot().provider;
  assert.equal(provider.state, "usage-limit", "the reason is reported as a usage limit, not a dead workspace");
  assert.match(provider.message ?? "", /rate or usage limit.*429 Too Many Requests/);
  const failed = task().messages.find(({ text }) => text === "Summarize the release.");
  assert.equal(failed?.state, "failed");
  assert(task().messages.some(({ role, kind, text }) => role === "system" && kind === "error" && /429/.test(text)),
    "the failure stays in the transcript");
  assert.equal(retryableMessageId(task().messages), failed?.id);

  await send("Summarize the release.");
  assert.equal(runtime.snapshot().provider.state, "ready");
  assert.equal(fake.inputs.length, 2);
  assert.equal(retryableMessageId(task().messages), undefined);
  assert.equal(task().messages.at(-1)?.text, "Done.");
});

test("a rate limit that Codex retries successfully does not leave the workspace limited", async (t) => {
  const { runtime, fake, task, send } = await setup(t);
  fake.scripts = ["retried-rate-limit"];
  await send("Hello");
  assert.equal(runtime.snapshot().provider.state, "ready");
  assert.equal(task().status, "done");
});

test("a turn that fails while Codex reconnects reports the failure in the chat and keeps the workspace ready", async (t) => {
  const { runtime, fake, task, send } = await setup(t);
  fake.scripts = ["network-failure"];
  await send("Hello");
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert.equal(task().messages.find(({ text }) => text === "Hello")?.state, "failed");
  await send("Hello again");
  assert.equal(task().messages.at(-1)?.text, "Done.");
});

test("queued follow-ups pause visibly after a failed turn", async (t) => {
  const { runtime, fake, agentId, task } = await setup(t);
  fake.scripts = ["slow-fail"];
  await runtime.command({ type: "send", agentId, text: "First" });
  await waitFor(() => Boolean(task().canCancel));
  await runtime.command({ type: "send", agentId, text: "Second" });
  await waitFor(() => task().status !== "working");
  assert.equal(task().queueDepth, 1);
  assert.equal(task().queuePaused, true, "the chat offers Resume queue instead of stranding the message");
  await runtime.command({ type: "resumeQueue", agentId });
  await waitFor(() => task().messages.at(-1)?.text === "Done.");
});

test("a very large pasted message reaches the provider intact; only the provider's hard limit is refused", async (t) => {
  const { runtime, fake, agentId, task, send } = await setup(t);
  const large = "Log line with details about the failure.\n".repeat(5_000).trim();
  assert(large.length > 64 * 1024);
  await send(large);
  assert.equal(fake.inputs.at(-1), large);
  assert.equal(task().messages.find(({ role }) => role === "user")?.text, large);

  const atLimit = "😀".repeat(messageCharacterLimit);
  await send(atLimit);
  assert.equal(fake.inputs.at(-1), atLimit, "astral characters count once, as Codex counts them");

  const before = task().messages.length;
  await assert.rejects(runtime.command({ type: "send", agentId, text: "x".repeat(messageCharacterLimit + 1) }),
    /Message is too long \(1,048,577 characters, limit 1,048,576\)/);
  assert.equal(task().messages.length, before, "a refused message is not recorded");
  await send("Still works");
  assert.equal(task().messages.at(-1)?.text, "Done.");
});

test("message length helpers count Unicode characters", () => {
  assert.equal(messageLength("a😀b"), 3);
  assert.equal(messageLength("\ud800"), 1);
  assert.equal(messageLengthProblem("x".repeat(messageCharacterLimit)), undefined);
  assert.equal(messageLengthProblem("😀".repeat(messageCharacterLimit)), undefined);
  assert.match(messageLengthProblem("x".repeat(messageCharacterLimit + 1)) ?? "", /^Message is too long/);
});

test("only the latest failed plain user message offers Retry", () => {
  const user = (id: string, text: string, extra: Partial<WorkspaceMessage> = {}): WorkspaceMessage => ({ id, role: "user", text, ...extra });
  const error: WorkspaceMessage = { id: "e", role: "system", text: "Turn failed", kind: "error" };
  assert.equal(retryableMessageId([user("a", "One", { state: "failed" }), error]), "a");
  assert.equal(retryableMessageId([user("a", "One", { state: "failed" }), error, user("b", "Two")]), undefined);
  assert.equal(retryableMessageId([user("a", "One", { state: "failed" }), user("b", "Two", { state: "queued" })]), "a");
  assert.equal(retryableMessageId([user("a", "One", { state: "cancelled" })]), undefined);
  assert.equal(retryableMessageId([user("a", "Yes", { state: "failed", answersProductQuestionId: "q" })]), undefined);
  assert.equal(retryableMessageId([
    { id: "r", role: "system", text: "Edit files", implementationRequest: { status: "approved" } },
    user("a", implementationApprovalText, { state: "failed" }),
  ]), undefined);
});
