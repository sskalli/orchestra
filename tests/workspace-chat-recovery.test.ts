import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Event, Id, ProviderServer } from "../src/app-server.ts";
import { implementationApprovalText, messageCharacterLimit, messageLength, messageLengthProblem, OrderedSends, restoredDraft, retryableMessageId } from "../src/workspace-chat-recovery.ts";
import { WorkspaceRuntime, type WorkspaceMessage } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

type Script = "ok" | "rate-limit" | "retried-rate-limit" | "network-failure" | "slow-fail" | "slow-reconnect" | "disk-quota" | "hold";

/** A scripted stand-in for Codex App Server. Error payloads match what Codex 0.166 sends for a provider 429. */
class FakeAppServer implements ProviderServer {
  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;
  scripts: Script[] = [];
  inputs: string[] = [];
  threads = 0;
  limitAtStartup = false;
  held = new Map<string, () => void>();
  private turns = 0;

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "initialize") {
      if (this.limitAtStartup) this.onEvent?.({ method: "error", params: { error: { message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded" }, willRetry: false } } as Event);
      return {} as T;
    }
    if (method === "account/read") return { account: { type: "chatgpt" } } as T;
    if (method === "thread/start") return { thread: { id: `thread-${++this.threads}` }, modelProvider: "openai", model: "gpt-test" } as T;
    if (method === "turn/start") {
      const turn = { id: `turn-${++this.turns}`, rootTurnId: null, status: "inProgress" };
      this.inputs.push((params.input as { text: string }[])[0].text);
      const script = this.scripts.shift() ?? "ok";
      const threadId = String(params.threadId);
      setTimeout(() => this.play(script, turn.id, threadId), 5);
      return { turn } as T;
    }
    throw new Error(`Unexpected ${method}`);
  }

  private play(script: Script, turnId: string, threadId: string) {
    const emit = (method: string, params: Record<string, unknown>) =>
      this.onEvent?.({ method, params: { threadId, ...params } } as Event);
    const tooMany = { message: "exceeded retry limit, last status: 429 Too Many Requests",
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } };
    const retrying429 = { message: "Reconnecting... 1/1", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } },
      additionalDetails: "exceeded retry limit, last status: 429 Too Many Requests" };
    const fail = (error: { message: string }) =>
      emit("turn/completed", { turn: { id: turnId, rootTurnId: null, status: "failed", error } });
    const complete = () => {
      emit("item/agentMessage/delta", { turnId, itemId: `reply-${turnId}`, delta: "Done." });
      emit("turn/completed", { turn: { id: turnId, rootTurnId: null, status: "completed" } });
    };
    emit("turn/started", { turn: { id: turnId, rootTurnId: null, status: "inProgress" } });
    if (script === "ok") complete();
    if (script === "slow-reconnect") {
      emit("error", { turnId, willRetry: true, error: { message: "Reconnecting... 1/5",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } });
      this.held.set(turnId, complete);
    }
    if (script === "hold") this.held.set(turnId, complete);
    if (script === "disk-quota") fail({ message: "Disk quota exceeded while writing a temporary file." });
    if (script === "rate-limit") {
      emit("error", { turnId, error: retrying429, willRetry: true });
      emit("error", { turnId, error: tooMany, willRetry: false });
      fail(tooMany);
    }
    if (script === "retried-rate-limit") {
      emit("error", { turnId, error: retrying429, willRetry: true });
      complete();
    }
    if (script === "network-failure") {
      const reconnecting = { message: "Reconnecting... waiting for network",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } };
      emit("error", { turnId, error: reconnecting, willRetry: true });
      fail({ message: "stream disconnected before completion" });
    }
    if (script === "slow-fail") setTimeout(() => fail({ message: "The model rejected the request." }), 80);
  }

  release(turnId: string) {
    this.held.get(turnId)?.();
    this.held.delete(turnId);
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

async function setup(t: { after: (fn: () => Promise<void>) => void }, configure?: (fake: FakeAppServer) => void) {
  const project = mkdtempSync(join(tmpdir(), "orchestra-recovery-"));
  const fake = new FakeAppServer();
  configure?.(fake);
  const runtime = new WorkspaceRuntime({ cwd: project, store: workspaceStore(project, join(project, "state")), createServer: () => fake });
  t.after(async () => {
    await runtime.close();
    rmSync(project, { recursive: true, force: true });
  });
  await runtime.start();
  if (!fake.limitAtStartup) assert.equal(runtime.snapshot().provider.state, "ready");
  const agentId = String(await runtime.command({ type: "createTask", name: "Recovery", projectIds: [] }));
  const task = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!;
  const settled = () => waitFor(() => task().status !== "working" && !task().canCancel);
  const send = async (text: string) => {
    await runtime.command({ type: "send", agentId, text });
    await settled();
  };
  return { runtime, fake, agentId, task, send, settled };
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
  assert.equal(task().queueDepth, 2, "the failed message goes back ahead of the follow-up");
  assert.equal(task().queuePaused, true, "the chat offers Resume queue instead of stranding the message");
  assert.equal(retryableMessageId(task().messages), undefined, "Resume queue resends it, so Retry is not offered too");
  const users = task().messages.filter(({ role }) => role === "user").map(({ text, state }) => `${text}:${state ?? "sent"}`);
  assert.deepEqual(users, ["First:failed", "First:queued", "Second:queued"]);
  await runtime.command({ type: "resumeQueue", agentId });
  await waitFor(() => fake.inputs.length === 3 && task().queueDepth === 0 && task().status !== "working");
  assert.deepEqual(fake.inputs, ["First", "First", "Second"]);
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
  assert.match(messageLengthProblem("x".repeat(messageCharacterLimit - 10), 20) ?? "",
    /\(1,048,566 characters, limit 1,048,556\)/, "text Orchestra adds around the message counts against the limit");
});

test("only the latest failed plain user message offers Retry", () => {
  const user = (id: string, text: string, extra: Partial<WorkspaceMessage> = {}): WorkspaceMessage => ({ id, role: "user", text, ...extra });
  const error: WorkspaceMessage = { id: "e", role: "system", text: "Turn failed", kind: "error" };
  assert.equal(retryableMessageId([user("a", "One", { state: "failed" }), error]), "a");
  assert.equal(retryableMessageId([user("a", "One", { state: "failed" }), error, user("b", "Two")]), undefined);
  assert.equal(retryableMessageId([user("a", "One", { state: "failed" }), user("b", "Two", { state: "queued" })]), undefined);
  assert.equal(retryableMessageId([user("a", "One", { state: "cancelled" })]), undefined);
  assert.equal(retryableMessageId([user("a", "Yes", { state: "failed", answersProductQuestionId: "q" })]), undefined);
  assert.equal(retryableMessageId([
    { id: "r", role: "system", text: "Edit files", implementationRequest: { status: "approved" } },
    user("a", implementationApprovalText, { state: "failed" }),
  ]), undefined);
});

test("a provider retry in one task does not block the other tasks", async (t) => {
  const { runtime, fake, agentId, task } = await setup(t);
  const otherId = String(await runtime.command({ type: "createTask", name: "Other", projectIds: [] }));
  const other = () => runtime.snapshot().agents.find(({ id }) => id === otherId)!;
  fake.scripts = ["slow-reconnect"];
  await runtime.command({ type: "send", agentId, text: "Long task" });
  await waitFor(() => Boolean(task().reconnecting));
  assert.equal(runtime.snapshot().provider.state, "ready", "a turn-level retry is not a lost connection");
  assert.match(task().reconnecting ?? "", /Reconnecting/);
  assert.equal(task().canCancel, true, "the retrying task keeps Stop");
  await runtime.command({ type: "send", agentId: otherId, text: "Meanwhile" });
  await waitFor(() => other().messages.at(-1)?.text === "Done.");
  fake.release("turn-1");
  await waitFor(() => task().status === "done");
  assert.equal(task().reconnecting, undefined);
});

test("usage-limit notices clear on another task's success and on an unrelated failure, but not on non-limit errors", async (t) => {
  const { runtime, fake, agentId, task, send } = await setup(t);
  const otherId = String(await runtime.command({ type: "createTask", name: "Other", projectIds: [] }));
  const other = () => runtime.snapshot().agents.find(({ id }) => id === otherId)!;
  fake.scripts = ["disk-quota"];
  await send("Write a file");
  assert.equal(runtime.snapshot().provider.state, "ready", "a disk quota error is not a usage limit");

  fake.scripts = ["rate-limit"];
  await send("Again");
  assert.equal(runtime.snapshot().provider.state, "usage-limit");
  fake.scripts = ["ok"];
  await runtime.command({ type: "send", agentId: otherId, text: "Other task" });
  await waitFor(() => other().messages.at(-1)?.text === "Done.");
  assert.equal(runtime.snapshot().provider.state, "ready", "another task's success clears the limit");

  fake.scripts = ["rate-limit", "disk-quota"];
  await send("Third");
  assert.equal(runtime.snapshot().provider.state, "usage-limit");
  await send("Fourth");
  assert.equal(runtime.snapshot().provider.state, "ready", "a later failure for another reason clears the limit");
  assert.equal(task().messages.at(-1)?.kind, "error");
});

test("a usage limit reported during startup stays visible", async (t) => {
  const { runtime, send } = await setup(t, (fake) => { fake.limitAtStartup = true; });
  assert.equal(runtime.snapshot().provider.state, "usage-limit");
  await send("Hello");
  assert.equal(runtime.snapshot().provider.state, "ready");
});

test("the command endpoint answers an oversized body with 413 instead of reading it forever", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "orchestra-recovery-server-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = spawn(process.execPath, [fileURLToPath(new URL("../src/workspace-server.ts", import.meta.url))], {
    env: { ...process.env, ORCHESTRA_PORT: String(port), ORCHESTRA_STATE_DIR: state }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    server.kill();
    rmSync(state, { recursive: true, force: true });
  });
  const origin = await new Promise<string>((resolve, reject) => {
    server.stdout.on("data", (chunk: Buffer) => {
      const found = /available at (http:\/\/\S+)/.exec(String(chunk));
      if (found) resolve(found[1]);
    });
    server.once("exit", (code) => reject(new Error(`Server exited with ${code}`)));
  });
  const post = (body: string) => fetch(`${origin}/api/command`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body,
  });

  const large = await post(JSON.stringify({ type: "send", agentId: "missing", text: "x".repeat(200_000) }));
  assert.equal(large.status, 400, "a body above the old 64 KB limit is parsed normally");
  assert.match((await large.json()).error, /no longer exists/);

  const oversized = await post(JSON.stringify({ type: "send", agentId: "missing", text: "\u0001".repeat(messageCharacterLimit * 3) }))
    .then((response) => response.status, () => "reset");
  assert(oversized === 413 || oversized === "reset", `unexpected ${oversized}`);
});

test("an App Server exit does not re-queue the in-flight message, which may already have run", async (t) => {
  const { runtime, fake, agentId, task } = await setup(t);
  fake.scripts = ["hold"];
  await runtime.command({ type: "send", agentId, text: "Edit the file" });
  await waitFor(() => Boolean(task().canCancel));
  await runtime.command({ type: "send", agentId, text: "Then summarize" });
  fake.onFailure?.(new Error("App Server exited (code 1, signal null)"));
  await waitFor(() => task().status !== "working");
  assert.equal(task().queuePaused, true);
  assert.deepEqual(task().messages.filter(({ state }) => state === "queued").map(({ text }) => text), ["Then summarize"],
    "only the follow-up stays queued; the interrupted message is reconciled on restart instead of resent");
});

test("ordered sends stop after a failure and give back every unsent text in order", async () => {
  const sends = new OrderedSends();
  const sent: string[] = [];
  const send = async (text: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (text === "one") throw new Error("offline");
    sent.push(text);
  };
  const outcomes = await Promise.all(["zero", "one", "two", "three"].map((text) => sends.run(text, send)));
  assert.deepEqual(sent, ["zero"], "sends after the failure never run");
  assert.deepEqual(outcomes[0], { sent: true });
  assert.deepEqual(outcomes[1].sent ? [] : outcomes[1].restore, ["one", "two", "three"]);
  assert.deepEqual(outcomes.slice(2).map((outcome) => outcome.sent ? "sent" : outcome.restore), [[], []]);
  assert.deepEqual(await sends.run("four", send), { sent: true }, "later sends work again");
  assert.equal(restoredDraft(["one", "two"], "typed since"), "one\ntwo\ntyped since");
  assert.equal(restoredDraft(["one"], "  "), "one");
});
