import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceUsage } from "../src/workspace-usage.ts";

function tokens(inputTokens: number, outputTokens = 0, cachedInputTokens = 0) {
  return { totalTokens: inputTokens + outputTokens, inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens: 0 };
}

test("multiple updates are cumulative and replay remains idempotent across restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-usage-ledger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "usage.json");
  let usage = new WorkspaceUsage(path);
  usage.registerThread("thread", true, "coder");
  const attribution = { agentId: "coder", runId: "run", model: "example" };
  usage.registerTurn("thread", "first", attribution);
  const first = tokens(17_944, 9);
  usage.observe("thread", "first", { total: first });
  usage = new WorkspaceUsage(path);
  usage.registerThread("thread", false, "coder");
  usage.observe("thread", "first", { total: first });
  usage.observe("thread", "second", { total: tokens(37_110, 20, 17_792) });
  usage.registerTurn("thread", "second", attribution);
  usage.registerTurn("thread", "skill", attribution);
  usage.observe("thread", "skill", { total: tokens(58_339, 73, 17_792) });
  usage.observe("thread", "skill", { total: tokens(79_710, 83, 36_864) });
  usage.observe("thread", "skill", { total: tokens(58_339, 73, 17_792) });
  const exported = new WorkspaceUsage(path).snapshot();
  assert.equal(exported.turns.find((turn) => turn.turnId === "skill")?.tokens?.totalTokens, 42_663);
  assert.equal(exported.byRun.run.tokens?.totalTokens, 79_793);
  assert.equal(exported.byAgent.coder.tokens?.cachedInputTokens, 36_864);
});

test("task-only usage imports retained sessions without rewriting the original history", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-usage-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousPath = join(directory, "previous.json");
  const path = join(directory, "tasks.json");
  const previous = new WorkspaceUsage(previousPath);
  for (const id of ["direct", "coordinator"]) {
    previous.registerThread(id, true, id);
    previous.registerTurn(id, "turn", { agentId: id });
    previous.observe(id, "turn", { total: tokens(20, 2) });
  }
  const original = readFileSync(previousPath, "utf8");
  const migrated = new WorkspaceUsage(path, previousPath);
  migrated.retainAgents(["direct"]);
  assert.equal(new WorkspaceUsage(path).summary().total.tokens?.totalTokens, 22);
  assert.equal(readFileSync(previousPath, "utf8"), original);
});

test("legacy resume establishes a baseline without charging historical usage", () => {
  const usage = new WorkspaceUsage();
  usage.registerThread("thread", false, "agent");
  usage.registerTurn("thread", "current", { agentId: "agent" });
  usage.observe("thread", "current", { total: tokens(300) });
  assert.equal(usage.summary().total.tokens, null);
  assert.equal(usage.summary().total.unknownTurns, 1);
  usage.observe("thread", "current", { total: tokens(350) });
  assert.deepEqual(usage.summary().total, { tokens: tokens(50), observedTurns: 0, partialTurns: 1, unknownTurns: 0 });
  usage.registerTurn("thread", "next", { agentId: "agent" });
  usage.observe("thread", "next", { total: tokens(375) });
  assert.deepEqual(usage.summary().total, { tokens: tokens(75), observedTurns: 1, partialTurns: 1, unknownTurns: 0 });
});

test("a cumulative gap across turns is counted at workspace level without charging the later turn", () => {
  const usage = new WorkspaceUsage();
  usage.registerThread("thread", true, "agent");
  usage.registerTurn("thread", "unreported", { agentId: "agent", runId: "first" });
  usage.observe("thread", "reported", { total: tokens(100, 10), last: tokens(40, 5) });
  usage.registerTurn("thread", "reported", { agentId: "agent", runId: "second" });
  const summary = usage.summary();
  assert.deepEqual(summary.total, { tokens: tokens(100, 10), observedTurns: 0, partialTurns: 1, unknownTurns: 1 });
  assert.deepEqual(summary.unattributedTokens, tokens(60, 5));
  assert.deepEqual(summary.byRun.second.tokens, tokens(40, 5));

  usage.registerTurn("thread", "batched", { agentId: "agent", runId: "third" });
  usage.observe("thread", "batched", { total: tokens(180, 20), last: tokens(30, 4) });
  assert.deepEqual(usage.summary().byRun.third.tokens, tokens(80, 10));
  assert.equal(usage.summary().byRun.third.observedTurns, 1);
  assert.deepEqual(usage.summary().unattributedTokens, tokens(60, 5));
});

test("deletion purges turns and checkpoints for removed participants", () => {
  const usage = new WorkspaceUsage();
  usage.registerThread("pilot-thread", true, "pilot");
  usage.registerThread("worker-thread", true, "worker");
  usage.registerTurn("pilot-thread", "pilot", { agentId: "pilot" });
  usage.observe("pilot-thread", "pilot", { total: tokens(10) });
  usage.observe("worker-thread", "worker", { total: tokens(20) });
  usage.retainAgents(["pilot"]);
  const exported = usage.snapshot();
  assert.equal(exported.total.tokens?.totalTokens, 10);
  assert.equal(exported.turns.length, 1);
  usage.observe("worker-thread", "worker", { total: tokens(30) });
  assert.equal(usage.summary().total.tokens?.totalTokens, 10);
});

test("resume guards the first new checkpoint even without a saved active turn", () => {
  const usage = new WorkspaceUsage();
  const attribution = { agentId: "pilot" };
  usage.registerThread("thread", true, "pilot");
  usage.registerTurn("thread", "before", { ...attribution, runId: "before" });
  usage.observe("thread", "before", { total: tokens(100) });
  usage.markResumedThread("thread");
  usage.observe("thread", "before", { total: tokens(110), last: tokens(10) });

  // The new turn's usage can arrive before its acknowledgement.
  usage.observe("thread", "after", { total: tokens(170), last: tokens(20) });
  usage.registerTurn("thread", "after", { ...attribution, runId: "after" });
  assert.equal(usage.summary().byRun.before.tokens?.totalTokens, 110);
  assert.equal(usage.summary().byRun.after.tokens?.totalTokens, 20);
  assert.equal(usage.summary().unattributedTokens?.totalTokens, 40);

  usage.observe("thread", "after", { total: tokens(200), last: tokens(30) });
  usage.registerTurn("thread", "next", { ...attribution, runId: "next" });
  usage.observe("thread", "next", { total: tokens(260), last: tokens(25) });
  assert.equal(usage.summary().byRun.after.tokens?.totalTokens, 50);
  assert.equal(usage.summary().byRun.next.tokens?.totalTokens, 60);
  assert.equal(usage.summary().unattributedTokens?.totalTokens, 40);
});

test("resume leaves the full increment unattributed when its latest breakdown is inconsistent", () => {
  const usage = new WorkspaceUsage();
  usage.registerThread("thread", true, "pilot");
  usage.registerTurn("thread", "before", { agentId: "pilot", runId: "before" });
  usage.observe("thread", "before", { total: tokens(100, 10) });
  usage.markResumedThread("thread");
  usage.registerTurn("thread", "after", { agentId: "pilot", runId: "after" });
  usage.observe("thread", "after", { total: tokens(120, 10), last: tokens(19, 1) });

  assert.equal(usage.summary().byRun.after.tokens, null);
  assert.deepEqual(usage.summary().unattributedTokens, tokens(20));
});
