import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionTaskCount, documentTitle } from "../src/workspace-status.ts";
import { nodePositions, workspacePreferences } from "../src/workspace-preferences.ts";
import type { WorkspaceAgent, WorkspaceMessage } from "../src/workspace-runtime.ts";

type Agent = Pick<WorkspaceAgent, "id" | "parentId" | "archivedAt" | "status" | "messages">;
const agent = (id: string, status: Agent["status"], extra: Partial<Agent> = {}): Agent =>
  ({ id, status, messages: [], ...extra });
const pendingQuestion = { productQuestion: { status: "pending" } } as WorkspaceMessage;

test("tab title counts top-level tasks that need the user", () => {
  assert.equal(documentTitle([]), "Orchestra");
  assert.equal(documentTitle([agent("a", "working"), agent("b", "awaiting-confirmation"), agent("c", "done")]), "Orchestra");
  const agents = [
    agent("root1", "working"),
    agent("child1", "error", { parentId: "root1" }),
    agent("grandchild1", "attention", { parentId: "child1" }),
    agent("root2", "idle", { messages: [pendingQuestion] }),
    agent("root3", "error", { archivedAt: "2026-01-01" }),
    agent("root4", "working"),
    agent("child4", "error", { parentId: "root4", archivedAt: "2026-01-01" }),
    agent("root5", "attention"),
  ];
  assert.equal(attentionTaskCount(agents), 3);
  assert.equal(documentTitle(agents), "Orchestra (3)");
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
