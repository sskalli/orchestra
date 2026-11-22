import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

// Seed task relationships without invoking a provider or depending on demo copy.
function fixture(options: ConstructorParameters<typeof WorkspaceRuntime>[0] = { cwd: process.cwd() }) {
  const runtime = new WorkspaceRuntime(options);
  const internal = runtime as any;
  internal.restore([]);
  internal.state.provider.state = "ready";
  const pm = internal.createAgent("pm", "Study", "worker");
  const sibling = internal.createAgent("sibling", "Other task", "worker");
  for (const session of [pm, sibling]) {
    session.agent.projectId = undefined;
    session.agent.directTask = { projectIds: [], phase: "planning" };
    session.threadId = `${session.agent.id}-thread`;
    internal.threadSessions.set(session.threadId, session);
  }
  const researcher = internal.createAgent("researcher", "Research", "worker", pm.agent.id);
  researcher.agent.nativeChild = true;
  researcher.agent.projectId = undefined;
  researcher.threadId = "researcher-thread";
  internal.threadSessions.set(researcher.threadId, researcher);
  researcher.agent.messages.push({ id: "report", role: "assistant", text: "Research report" });
  return { runtime, internal, pm, researcher, sibling };
}

test("archive and restore affect the whole task and its native children only", async () => {
  const { runtime } = fixture();
  try {
    await assert.rejects(runtime.command({ type: "archive", agentId: "researcher" }), /owning task/i);
    await runtime.command({ type: "archive", agentId: "pm" });
    assert.deepEqual(runtime.snapshot().agents.filter(({ archivedAt }) => archivedAt).map(({ id }) => id), ["pm", "researcher"]);
    await runtime.command({ type: "restore", agentId: "pm" });
    const agents = runtime.snapshot().agents;
    assert(agents.every(({ archivedAt }) => !archivedAt));
    assert.equal(agents.find(({ id }) => id === "researcher")?.messages[0].text, "Research report");
  } finally { await runtime.close(); }
});

test("archived conversations reject sends, steering, queue resume, and late provider events", async () => {
  const { runtime, internal, pm } = fixture();
  try {
    pm.threadId = "old-thread";
    internal.threadSessions.set(pm.threadId, pm);
    await runtime.command({ type: "archive", agentId: "pm" });
    const before = runtime.snapshot();
    for (const command of [
      { type: "send", agentId: "pm", text: "Run again" },
      { type: "steer", agentId: "pm", text: "Run again" },
      { type: "resumeQueue", agentId: "pm" },
    ] as const) await assert.rejects(runtime.command(command), /archiv|restore/i);
    internal.onEvent({ method: "turn/started", params: { threadId: "old-thread", turn: { id: "late", status: "inProgress" } } });
    internal.onEvent({ method: "item/agentMessage/delta", params: { threadId: "old-thread", turnId: "late", itemId: "late-text", delta: "Late result" } });
    assert.deepEqual(runtime.snapshot(), before);
  } finally { await runtime.close(); }
});

test("running native children must finish before the owning task can be archived or deleted", async () => {
  const { runtime, researcher } = fixture();
  researcher.agent.status = "working";
  try {
    await assert.rejects(runtime.command({ type: "archive", agentId: "pm", stopRunning: true }), /subagents/i);
    await assert.rejects(runtime.command({ type: "delete", agentId: "pm" }), /subagents/i);
    assert(runtime.snapshot().agents.every(({ archivedAt }) => !archivedAt));
    researcher.agent.status = "done";
    await runtime.command({ type: "archive", agentId: "pm" });
    assert(runtime.snapshot().agents.find(({ id }) => id === "researcher")?.archivedAt);
  } finally { await runtime.close(); }
});

test("uncertain recovery blocks permanent deletion and archival", async () => {
  const { runtime, pm } = fixture();
  try {
    pm.recovery = { messageId: "uncertain", turnId: "unknown-turn" };
    for (const type of ["archive", "delete"] as const) {
      await assert.rejects(runtime.command({ type, agentId: "pm" }));
      assert.equal(runtime.snapshot().agents.find((agent) => agent.id === "pm")!.archivedAt, undefined);
    }
  } finally { await runtime.close(); }
});

test("opening a task prevents destructive lifecycle changes", async () => {
  const { runtime, pm } = fixture();
  try {
    pm.opening = true;
    for (const type of ["archive", "delete"] as const) {
      await assert.rejects(runtime.command({ type, agentId: "pm" }), /opening/i);
    }
  } finally { await runtime.close(); }
});

test("failed provider cancellation leaves the subtree visible and blocks deletion", async () => {
  const { runtime, internal, pm } = fixture({ cwd: process.cwd() });
  pm.threadId = "busy-thread";
  pm.run = { message: { id: "active", role: "user", text: "Work" }, turn: { id: "busy-turn", status: "inProgress" } };
  pm.agent.status = "working";
  let interrupts = 0;
  internal.server = {
    call: async (method: string, params: any) => {
      assert.equal(method, "turn/interrupt");
      assert.deepEqual(params, { threadId: "busy-thread", turnId: "busy-turn" });
      interrupts++;
      throw new Error("Fixture interrupt transport failure");
    },
    close: async () => {},
  };
  try {
    await assert.rejects(runtime.command({ type: "archive", agentId: "pm", stopRunning: true }), /transport failure/);
    assert.equal(interrupts, 1);
    const agents = runtime.snapshot().agents;
    assert(agents.every((agent) => !agent.archivedAt && !agent.lifecycleBusy));
    assert.match(agents.find((agent) => agent.id === "pm")!.lifecycleBlockedReason!, /transport failure/);
    assert.equal(agents.find((agent) => agent.id === "pm")!.status, "working");
    await assert.rejects(runtime.command({ type: "delete", agentId: "pm" }), /running/i);
  } finally { await runtime.close(); }
});

test("Codex stop and archive waits for terminal provider evidence and prevents queued work starting", async () => {
  const { runtime, internal, pm } = fixture({ cwd: process.cwd() });
  pm.threadId = "busy-thread";
  pm.run = { message: { id: "active", role: "user", text: "Work" }, turn: { id: "busy-turn", status: "inProgress" } };
  pm.agent.status = "working";
  const queued = { id: "later", role: "user", text: "Later", state: "queued" };
  pm.queue.push(queued); pm.agent.messages.push(queued); pm.agent.queueDepth = 1;
  internal.threadSessions.set(pm.threadId, pm);
  const calls: string[] = [];
  internal.server = {
    call: async (method: string) => { calls.push(method); return {}; },
    close: async () => {},
  };
  try {
    const archiving = runtime.command({ type: "archive", agentId: "pm", stopRunning: true });
    await Promise.resolve();
    assert.deepEqual(calls, ["turn/interrupt"]);
    const pending = runtime.snapshot().agents.find((agent) => agent.id === "pm")!;
    assert.equal(pending.archivedAt, undefined, "interrupt acknowledgement alone must not hide the agent");
    assert.equal(pending.lifecycleBusy, true);
    internal.onEvent({ method: "turn/completed", params: {
      threadId: "busy-thread", turn: { id: "busy-turn", status: "interrupted" },
    } });
    await archiving;
    const archived = runtime.snapshot().agents.find((agent) => agent.id === "pm")!;
    assert(archived.archivedAt);
    assert.equal(archived.lifecycleBusy, undefined);
    assert.equal(archived.queuePaused, true);
    assert.equal(pm.run, undefined);
    assert.deepEqual(calls, ["turn/interrupt"], "finish must not drain into another provider turn");
  } finally { await runtime.close(); }
});

test("a Codex interruption cancels the active message and pauses queued follow-ups", async () => {
  const { runtime, internal, pm } = fixture({ cwd: process.cwd() });
  pm.threadId = "busy-thread";
  const active = { id: "active", role: "user", text: "Work", state: "submitted" };
  pm.run = { message: active, turn: { id: "busy-turn", status: "inProgress" } };
  pm.agent.messages.push(active);
  pm.agent.status = "working";
  internal.threadSessions.set(pm.threadId, pm);
  try {
    await runtime.command({ type: "send", agentId: "pm", text: "Later" });
    internal.onEvent({ method: "turn/completed", params: {
      threadId: "busy-thread", turn: { id: "busy-turn", status: "interrupted" },
    } });
    const agent = runtime.snapshot().agents.find((entry) => entry.id === "pm")!;
    assert.equal(pm.run, undefined);
    assert.equal(agent.messages.find((entry) => entry.id === active.id)?.state, "cancelled");
    assert.equal(agent.status, "idle");
    assert.equal(agent.queuePaused, true);
    assert.equal(agent.queueDepth, 1);
    assert.equal(pm.queue[0].state, "queued");
  } finally { await runtime.close(); }
});

test("a resumed provider thread with an active turn remains protected even without saved run metadata", async () => {
  const { runtime, internal, pm } = fixture({ cwd: process.cwd() });
  pm.threadId = "active-thread";
  internal.server = {
    call: async (method: string) => {
      assert.equal(method, "thread/resume");
      return { thread: { id: "active-thread", status: { type: "active" } }, modelProvider: "openai" };
    },
    close: async () => {},
  };
  try {
    await internal.resumeThread({ agent: pm.agent, threadId: pm.threadId, toolVersion: 6 });
    assert.match(pm.agent.unavailableReason, /active turn/i);
    for (const type of ["archive", "delete"] as const) {
      await assert.rejects(runtime.command({ type, agentId: "pm" }), /unresolved/i);
      assert.equal(runtime.snapshot().agents.find((agent) => agent.id === "pm")!.archivedAt, undefined);
    }
  } finally { await runtime.close(); }
});

for (const action of ["archive", "restore", "delete"] as const) {
  test(`${action} rolls back its visible lifecycle change if saving fails`, async () => {
    let failSave = false;
    let saved: unknown;
    const store = {
      load: () => undefined,
      usagePath: "",
      save: (sessions: unknown) => {
        if (failSave) throw new Error("Fixture disk full");
        saved = structuredClone(sessions);
      },
    };
    const { runtime, internal } = fixture({ cwd: process.cwd(), store });
    internal.storageReady = true;
    // No provider is needed: this test isolates atomic saved-state changes.
    internal.state.provider.state = "signed-out";
    try {
      if (action !== "archive") await runtime.command({ type: "archive", agentId: "pm" });
      const before = runtime.snapshot().agents.map(({ id, archivedAt, messages }) => ({ id, archivedAt, messages }));
      const beforeSaved = structuredClone(saved);
      failSave = true;
      await assert.rejects(runtime.command({ type: action, agentId: "pm" }), /could not be saved/i);
      assert.deepEqual(runtime.snapshot().agents.map(({ id, archivedAt, messages }) => ({ id, archivedAt, messages })), before);
      assert.deepEqual(saved, beforeSaved);
      assert.equal(runtime.snapshot().provider.state, "error");
      assert(runtime.snapshot().agents.every((agent) => !agent.lifecycleBusy));
    } finally { await runtime.close(); }
  });
}

test("archived queues stay paused until the user resumes them", async () => {
  const { runtime, internal, pm } = fixture();
  const queued = { id: "queued", role: "user", text: "Keep for later", state: "queued" };
  pm.queue.push(queued);
  pm.agent.messages.push(queued);
  pm.agent.queueDepth = 1;
  pm.agent.queuePaused = true;
  try {
    await runtime.command({ type: "archive", agentId: "pm" });
    assert.equal(internal.drain(pm), false);
    assert.equal(pm.run, undefined);
    assert.equal(pm.agent.queuePaused, true);
    await runtime.command({ type: "restore", agentId: "pm" });
    assert.equal(pm.run, undefined, "restoring must not silently replay queued work");
    assert.equal(pm.agent.queuePaused, true);
    assert.equal(pm.queue[0].text, "Keep for later");
  } finally { await runtime.close(); }
});

test("deletion removes subtree records but preserves history and project/worktree files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-delete-"));
  const project = join(directory, "project");
  const candidate = join(directory, "candidate");
  mkdirSync(project); mkdirSync(candidate);
  writeFileSync(join(project, "source.txt"), "project remains");
  writeFileSync(join(candidate, "changes.txt"), "candidate remains");
  const { runtime, internal, pm } = fixture({ cwd: project });
  pm.agent.candidate = { path: candidate, base: "baseline" };
  internal.sessions.get("sibling").agent.messages.push({ id: "historic", role: "system", text: "Research delivered", sourceAgentId: "researcher" });
  try {
    await runtime.command({ type: "archive", agentId: "pm" });
    await runtime.command({ type: "delete", agentId: "pm" });
    const agents = runtime.snapshot().agents;
    assert(!agents.some((agent) => ["pm", "researcher"].includes(agent.id)));
    assert(agents.some((agent) => agent.id === "sibling"));
    assert.equal(agents.find(({ id }) => id === "sibling")?.messages.find(({ id }) => id === "historic")?.text, "Research delivered");
    assert.equal(readFileSync(join(project, "source.txt"), "utf8"), "project remains");
    assert.equal(readFileSync(join(candidate, "changes.txt"), "utf8"), "candidate remains");
    await assert.rejects(runtime.command({ type: "restore", agentId: "pm" }), /no longer exists/i);
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("archive and deletion persist across a saved workspace reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-archive-state-"));
  const store = workspaceStore("/fixture/project", directory);
  const { runtime, internal } = fixture({ cwd: "/fixture/project", store });
  internal.storageReady = true;
  let reopened: WorkspaceRuntime | undefined;
  try {
    await runtime.command({ type: "archive", agentId: "pm" });
    const saved = store.load()!;
    assert(saved.find((entry) => entry.agent.id === "researcher")!.agent.archivedAt);
    reopened = new WorkspaceRuntime({ cwd: "/fixture/project", store });
    (reopened as any).restore(saved);
    (reopened as any).storageReady = true;
    (reopened as any).state.provider.state = "ready";
    assert(reopened.snapshot().agents.find((agent) => agent.id === "pm")!.archivedAt);
    await reopened.command({ type: "delete", agentId: "pm" });
    assert(!store.load()!.some((entry) => ["pm", "researcher"].includes(entry.agent.id)));
  } finally {
    await runtime.close(); await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
