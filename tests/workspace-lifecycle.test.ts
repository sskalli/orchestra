import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

// Seed known relationships without invoking a provider or depending on demo copy.
function fixture(options: ConstructorParameters<typeof WorkspaceRuntime>[0] = { cwd: process.cwd(), demo: true }) {
  const runtime = new WorkspaceRuntime(options);
  const internal = runtime as any;
  for (const session of internal.sessions.values()) clearTimeout(session.run?.demoTimer);
  internal.restore([{ agent: {
    id: "coordinator", name: "Pilot", role: "coordinator", status: "idle", messages: [], queueDepth: 0, canSteer: false,
  } }]);
  if (!options.demo) internal.state.provider.state = "ready";
  const lead = internal.createAgent("lead", "Feature", "lead", "coordinator");
  const pm = internal.createAgent("pm", "Study", "worker", "lead");
  const researcher = internal.createAgent("researcher", "Research", "worker", "pm");
  const sibling = internal.createAgent("sibling", "Other", "worker", "lead");
  const other = internal.createAgent("other", "Other team", "lead", "coordinator");
  for (const session of [lead, pm, researcher, sibling, other]) {
    session.agent.messages.push({ id: `${session.agent.id}-report`, role: "assistant", text: `Report from ${session.agent.name}` });
  }
  return { runtime, internal, lead, pm, researcher, sibling, other };
}

test("archive affects only a subtree and restore restores required ancestors", async () => {
  const { runtime } = fixture();
  try {
    await runtime.command({ type: "archive", agentId: "pm" });
    const archived = runtime.snapshot().agents.filter((agent) => agent.archivedAt).map((agent) => agent.id);
    assert.deepEqual(archived, ["pm", "researcher"]);
    assert.equal(runtime.snapshot().agents.find((agent) => agent.id === "researcher")!.messages[0].text, "Report from Research");
    await runtime.command({ type: "archive", agentId: "lead" });
    await runtime.command({ type: "restore", agentId: "researcher" });
    const agents = runtime.snapshot().agents;
    for (const id of ["lead", "pm", "researcher", "other"]) assert.equal(agents.find((agent) => agent.id === id)!.archivedAt, undefined, id);
    assert(agents.find((agent) => agent.id === "sibling")!.archivedAt, "restoring ancestors must not restore unrelated siblings");
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

test("pilot cannot be archived or deleted", async () => {
  const { runtime } = fixture();
  try {
    for (const type of ["archive", "delete"] as const) {
      await assert.rejects(runtime.command({ type, agentId: "coordinator" }));
      assert(runtime.snapshot().agents.some((agent) => agent.id === "coordinator"));
    }
  } finally { await runtime.close(); }
});

test("running work requires explicit stop before archive and cannot be deleted", async () => {
  const { runtime } = fixture();
  try {
    await runtime.command({ type: "send", agentId: "researcher", text: "Do a demo turn" });
    await runtime.command({ type: "send", agentId: "researcher", text: "Queued followup" });
    await assert.rejects(runtime.command({ type: "archive", agentId: "pm" }));
    await assert.rejects(runtime.command({ type: "delete", agentId: "pm" }));
    assert.equal(runtime.snapshot().agents.find((agent) => agent.id === "pm")!.archivedAt, undefined);
    await runtime.command({ type: "archive", agentId: "pm", stopRunning: true });
    const agent = runtime.snapshot().agents.find((entry) => entry.id === "researcher")!;
    assert(agent.archivedAt);
    assert.equal(agent.canSteer, false);
    assert.notEqual(agent.status, "working");
    assert(!agent.messages.some((entry) => entry.state === "streaming"));
  } finally { await runtime.close(); }
});

test("uncertain recovery blocks permanent deletion and archival", async () => {
  const { runtime, pm } = fixture();
  try {
    pm.recovery = { messageId: "uncertain", turnId: "unknown-turn" };
    for (const type of ["archive", "delete"] as const) {
      await assert.rejects(runtime.command({ type, agentId: "lead" }));
      assert.equal(runtime.snapshot().agents.find((agent) => agent.id === "lead")!.archivedAt, undefined);
    }
  } finally { await runtime.close(); }
});

test("opening conversations and unresolved approvals prevent destructive lifecycle changes", async () => {
  const { runtime, pm } = fixture();
  try {
    pm.opening = true;
    for (const type of ["archive", "delete"] as const) {
      await assert.rejects(runtime.command({ type, agentId: "lead" }), /opening/i);
    }
    pm.opening = false;
    const approval = { id: "approval", role: "system", text: "Approve?", approval: { id: "approval", state: "pending" } };
    pm.agent.messages.push(approval);
    pm.approvals.set("approval", { message: approval });
    await assert.rejects(runtime.command({ type: "delete", agentId: "lead" }), /approval/i);
    await assert.rejects(runtime.command({ type: "archive", agentId: "lead", stopRunning: true }), /unresolved/i);
    assert(runtime.snapshot().agents.every((agent) => !agent.archivedAt));
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
    await assert.rejects(runtime.command({ type: "archive", agentId: "lead", stopRunning: true }), /transport failure/);
    assert.equal(interrupts, 1);
    const agents = runtime.snapshot().agents;
    assert(agents.every((agent) => !agent.archivedAt && !agent.lifecycleBusy));
    assert.match(agents.find((agent) => agent.id === "lead")!.lifecycleBlockedReason!, /transport failure/);
    assert.equal(agents.find((agent) => agent.id === "pm")!.status, "working");
    await assert.rejects(runtime.command({ type: "delete", agentId: "lead" }), /running/i);
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
    const archiving = runtime.command({ type: "archive", agentId: "lead", stopRunning: true });
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
      await assert.rejects(runtime.command({ type, agentId: "lead" }), /unresolved/i);
      assert.equal(runtime.snapshot().agents.find((agent) => agent.id === "lead")!.archivedAt, undefined);
    }
  } finally { await runtime.close(); }
});

for (const action of ["archive", "restore", "delete"] as const) {
  test(`${action} rolls back its visible lifecycle change if saving fails`, async () => {
    let failSave = false;
    let saved: unknown;
    const store = {
      load: () => undefined,
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

test("archive save failure restores queued assignments both inside and outside the subtree", async () => {
  const { runtime, internal, pm, researcher, sibling } = fixture({
    cwd: process.cwd(),
    store: {
      load: () => undefined,
      save: (sessions) => {
        if (sessions.some(({ agent }) => agent.archivedAt)) throw new Error("Fixture disk full");
      },
    },
  });
  internal.storageReady = true;
  for (const [session, prerequisite] of [[researcher, pm], [sibling, researcher]]) {
    session.waitingFor = prerequisite.agent.id;
    const queued = { id: `${session.agent.id}-assignment`, role: "user", text: "Check result", state: "queued" };
    session.queue.push(queued);
    session.agent.messages.push(queued);
    session.agent.queueDepth = 1;
    session.agent.queuePaused = true;
    session.agent.status = "attention";
  }
  const assignmentState = () => [researcher, sibling].map(({ agent, queue, waitingFor }) => ({
    archivedAt: agent.archivedAt, status: agent.status, queueDepth: agent.queueDepth, queuePaused: agent.queuePaused,
    messages: agent.messages, queue, waitingFor,
  }));
  const before = structuredClone(assignmentState());
  try {
    await assert.rejects(runtime.command({ type: "archive", agentId: "pm" }), /could not be saved/i);
    assert.deepEqual(assignmentState(), before);
    for (const session of [researcher, sibling]) {
      assert.equal(session.queue[0], session.agent.messages.find((entry) => entry.id === session.queue[0].id));
    }
  } finally { await runtime.close(); }
});

test("archived queues stay paused and archived agents disappear from pilot recovery context", async () => {
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
    const reports = JSON.parse(internal.teamReportContext(internal.sessions.get("coordinator")).orchestra_team_reports.value);
    assert(!reports.some((entry: any) => ["pm", "researcher"].includes(entry.agentId)));
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
  const { runtime, internal, pm } = fixture({ cwd: project, demo: true });
  pm.agent.candidate = { path: candidate, base: "baseline" };
  internal.sessions.get("coordinator").agent.messages.push({ id: "historic", role: "system", text: "Research delivered", sourceAgentId: "researcher" });
  try {
    await runtime.command({ type: "archive", agentId: "pm" });
    await runtime.command({ type: "delete", agentId: "pm" });
    const agents = runtime.snapshot().agents;
    assert(!agents.some((agent) => ["pm", "researcher"].includes(agent.id)));
    assert(agents.some((agent) => agent.id === "sibling"));
    assert.equal(agents[0].messages.find((entry) => entry.id === "historic")!.text, "Research delivered");
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
