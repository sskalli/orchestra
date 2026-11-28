import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Event, Id, ProviderServer } from "../src/app-server.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

/** A stand-in for Codex App Server that answers every turn and records thread/revert calls. */
class FakeAppServer implements ProviderServer {
  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;
  inputs: string[] = [];
  reverts: { threadId: unknown; beforeTurnId: unknown }[] = [];
  revertError?: string;
  hold = false;
  held?: () => void;
  private turns = 0;

  async call<T>(method: string, params: Record<string, any>): Promise<T> {
    if (method === "initialize") return {} as T;
    if (method === "account/read") return { account: { type: "chatgpt" } } as T;
    if (method === "thread/start") return { thread: { id: "thread-1" }, modelProvider: "openai", model: "gpt-test" } as T;
    if (method === "thread/resume") {
      return { thread: { id: params.threadId, status: { type: "idle" } }, initialTurnsPage: { data: [] }, modelProvider: "openai", model: "gpt-test" } as T;
    }
    if (method === "thread/revert") {
      if (this.revertError) throw new Error(this.revertError);
      this.reverts.push({ threadId: params.threadId, beforeTurnId: params.beforeTurnId });
      return { thread: { id: params.threadId, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null } as T;
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${++this.turns}`, rootTurnId: null, status: "inProgress" };
      const text = params.input[0].text as string;
      this.inputs.push(text);
      const emit = (event: string, extra: Record<string, unknown>) =>
        this.onEvent?.({ method: event, params: { threadId: params.threadId, ...extra } } as Event);
      const complete = () => {
        emit("item/agentMessage/delta", { turnId: turn.id, itemId: `reply-${turn.id}`, delta: `Reply to ${text}` });
        emit("turn/completed", { turn: { ...turn, status: "completed" } });
      };
      setTimeout(() => {
        emit("turn/started", { turn });
        if (this.hold) this.held = complete;
        else complete();
      }, 5);
      return { turn } as T;
    }
    throw new Error(`Unexpected ${method}`);
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

async function setup(t: TestContext) {
  const project = mkdtempSync(join(tmpdir(), "orchestra-edit-"));
  const store = workspaceStore(project, join(project, "state"));
  const fake = new FakeAppServer();
  const runtime = new WorkspaceRuntime({ cwd: project, store, createServer: () => fake });
  t.after(async () => {
    await runtime.close();
    rmSync(project, { recursive: true, force: true });
  });
  await runtime.start();
  const agentId = String(await runtime.command({ type: "createTask", name: "Edit", projectIds: [] }));
  const task = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!;
  const settled = () => waitFor(() => task().status !== "working" && !task().canCancel && !task().queueDepth);
  const send = async (text: string) => {
    await runtime.command({ type: "send", agentId, text });
    await settled();
  };
  return { project, store, fake, runtime, agentId, task, send, settled };
}

test("editing a sent message rewinds the thread to before its turn and sends the edited text", async (t) => {
  const { project, store, fake, runtime, agentId, task, send, settled } = await setup(t);
  await send("First");
  await send("Second");
  await send("Third");
  const second = task().messages.find(({ text }) => text === "Second")!;
  assert.equal(second.turnId, "turn-2", "each sent message records the turn it started");

  await runtime.command({ type: "editMessage", agentId, messageId: second.id, text: "Second, edited" });
  await settled();

  assert.deepEqual(fake.reverts, [{ threadId: "thread-1", beforeTurnId: "turn-2" }]);
  assert.deepEqual(fake.inputs, ["First", "Second", "Third", "Second, edited"]);
  const transcript = task().messages.map(({ role, text }) => `${role}: ${text}`);
  assert.deepEqual(transcript, ["user: First", "assistant: Reply to First", "user: Second, edited", "assistant: Reply to Second, edited"]);

  await runtime.close();
  const reopened = new WorkspaceRuntime({ cwd: project, store, createServer: () => new FakeAppServer() });
  t.after(() => reopened.close());
  await reopened.start();
  const saved = reopened.snapshot().agents.find(({ id }) => id === agentId)!;
  assert.deepEqual(saved.messages.map(({ text }) => text), ["First", "Reply to First", "Second, edited", "Reply to Second, edited"],
    "the rewound transcript is what Orchestra saved");
});

test("a failed rewind leaves the conversation unchanged", async (t) => {
  const { fake, runtime, agentId, task, send } = await setup(t);
  await send("First");
  const before = task().messages.map(({ id }) => id);
  fake.revertError = "thread/revert is not supported for legacy threads";
  await assert.rejects(runtime.command({ type: "editMessage", agentId, messageId: before[0], text: "Changed" }),
    /could not rewind the conversation, so nothing changed\. thread\/revert is not supported/);
  assert.deepEqual(task().messages.map(({ id }) => id), before);
  assert.deepEqual(fake.inputs, ["First"]);
});

test("a message cannot be edited while a turn runs, nor one that did not start a turn", async (t) => {
  const { fake, runtime, agentId, task, send, settled } = await setup(t);
  await send("First");
  const first = task().messages.find(({ text }) => text === "First")!;
  const reply = task().messages.find(({ role }) => role === "assistant")!;
  await assert.rejects(runtime.command({ type: "editMessage", agentId, messageId: reply.id, text: "No" }),
    /Only a message you sent that started a turn can be edited/);

  fake.hold = true;
  await runtime.command({ type: "send", agentId, text: "Second" });
  await waitFor(() => Boolean(task().canCancel && fake.held));
  await assert.rejects(runtime.command({ type: "editMessage", agentId, messageId: first.id, text: "No" }),
    /Wait for the current turn/);
  fake.held?.();
  await settled();
  assert.deepEqual(fake.reverts, []);
});
