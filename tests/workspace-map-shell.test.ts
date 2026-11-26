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
