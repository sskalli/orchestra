import assert from "node:assert/strict";
import { test } from "node:test";
import { documentTitle } from "../src/workspace-status.ts";
import { unreadInbox } from "../src/workspace-flight-log.ts";
import type { InboxEvent } from "../src/workspace-inbox.tsx";
import { nodePositions, workspacePreferences } from "../src/workspace-preferences.ts";


test("tab title and Inbox count only notifications not yet seen in the Inbox or the task's chat", () => {
  assert.equal(documentTitle(0), "Orchestra");
  assert.equal(documentTitle(2), "Orchestra (2)");
  const entry = (sequence: number, agentId: string, tone: InboxEvent["tone"]) =>
    ({ sequence, event: { id: `${agentId}:${sequence}`, agentId, agentName: agentId, status: tone, tone, text: "" } });
  const log = { entries: [entry(5, "child1", "error"), entry(4, "root2", "attention"), entry(3, "root3", "done"), entry(2, "gone", "error")],
    latest: {}, sequence: 5, archivedAgentIds: [] };
  const roots: Record<string, string> = { child1: "root1", root2: "root2", root3: "root3" };
  const rootOf = (id: string) => roots[id];
  assert.deepEqual(unreadInbox(log, 0, {}, rootOf), { unread: true, alerts: 2 }, "a subagent failure counts for its task; removed tasks do not");
  assert.deepEqual(unreadInbox(log, 5, {}, rootOf), { unread: false, alerts: 0 }, "opening the Inbox marks everything seen");
  assert.deepEqual(unreadInbox(log, 0, { root1: 5 }, rootOf), { unread: true, alerts: 1 }, "opening a task's chat acknowledges its failure");
  assert.deepEqual(unreadInbox(log, 4, {}, rootOf), { unread: true, alerts: 1 }, "only newer notifications are unseen");
});

test("node positions are validated, filtered by known ids, and stored per workspace", () => {
  assert.deepEqual(nodePositions(null), {});
  assert.deepEqual(nodePositions([1]), {});
  assert.deepEqual(nodePositions({ a: { x: 1, y: 2 }, b: { x: "1", y: 2 }, c: null, d: { x: 3, y: 4, extra: 1 } }),
    { a: { x: 1, y: 2 }, d: { x: 3, y: 4 } });
  assert.deepEqual(nodePositions({ a: { x: 1, y: 2 }, gone: { x: 0, y: 0 } }, new Set(["a"])), { a: { x: 1, y: 2 } });

  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const state = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => state.get(key) ?? null, setItem: (key: string, value: string) => state.set(key, value) },
  });
  try {
    const first = workspacePreferences("/one", "codex");
    assert.deepEqual(first.readNodePositions(), {});
    first.writeNodePositions({ task: { x: 10, y: -20 } });
    assert.deepEqual(workspacePreferences("/one", "codex").readNodePositions(), { task: { x: 10, y: -20 } });
    assert.deepEqual(workspacePreferences("/two", "codex").readNodePositions(), {});
    state.set("orchestra:workspace:v1:codex:/one:node-positions", "{not json");
    assert.deepEqual(first.readNodePositions(), {});
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("task roots keep their positions when other roots come and go", async () => {
  const { placeRoots, teamCenters } = await import("../src/workspace-map-layout.ts");
  const [center, second, third] = teamCenters(3);
  const first = placeRoots(["a", "b", "c"], new Map());
  assert.deepEqual([...first.values()], [center, second, third]);

  // Archiving "a" must not move "b" or "c" once their positions are known.
  const afterArchive = placeRoots(["b", "c"], first);
  assert.deepEqual(afterArchive.get("b"), second);
  assert.deepEqual(afterArchive.get("c"), third);
  // Restoring it brings it back to its own place.
  assert.deepEqual(placeRoots(["a", "b", "c"], first).get("a"), center);

  // A new root skips default slots that overlap an existing (e.g. dragged) root.
  const known = new Map([["moved", { x: center.x + 20, y: center.y - 30 }], ["b", second]]);
  const placed = placeRoots(["moved", "b", "new"], known);
  assert.deepEqual(placed.get("new"), third);
  for (const [id, point] of placed) {
    for (const [other, otherPoint] of placed) {
      if (id !== other) assert.ok(Math.hypot(point.x - otherPoint.x, point.y - otherPoint.y) > 400, `${id} overlaps ${other}`);
    }
  }
});
