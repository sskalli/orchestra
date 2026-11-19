import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { WorkspaceRuntime } from "../src/workspace-runtime.ts";

const fixture = String.raw`
const assert = require("node:assert/strict");
const { appendFileSync, symlinkSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createInterface } = require("node:readline");
const decisions = join(dirname(process.cwd()), "decisions.jsonl");
const threads = new Map();
const send = (message) => console.log(JSON.stringify(message));
const event = (method, params) => send({ method, params });
const request = (id, method, params) => send({ id, method, params });
const reply = (id, result) => send({ id, result });
const turn = (threadId, status = "inProgress") => ({ id: threadId + "-turn", rootTurnId: null, status });
const complete = (threadId) => event("turn/completed", { threadId, turn: turn(threadId, "completed") });
const delegate = (threadId, name, duty) => request("delegate-" + threadId, "item/tool/call", {
  threadId, turnId: turn(threadId).id, callId: "call-" + threadId, tool: "delegate_agent",
  arguments: { name, duty, goal: "Test " + duty },
});
function fileRequest(id, threadId, paths, overrides = {}) {
  const params = { threadId, turnId: turn(threadId).id, itemId: "patch-" + id, startedAtMs: Date.now(), ...overrides };
  if (paths) event("item/started", {
    threadId, turnId: params.turnId,
    item: { type: "fileChange", id: params.itemId, status: "inProgress", changes: paths.map((path) => ({
      path, kind: { type: "add" }, diff: "+ fixture text",
    })) },
  });
  request(id, "item/fileChange/requestApproval", params);
}
function coderRequests() {
  const cwd = threads.get("coder").cwd;
  symlinkSync(process.cwd(), join(cwd, "external"));
  fileRequest("missing-changes", "coder", undefined);
  fileRequest("outside", "coder", [join(process.cwd(), "outside.txt")]);
  fileRequest("git-control", "coder", [join(cwd, ".git")]);
  fileRequest("external-link", "coder", [join(cwd, "external", "outside.txt")]);
  event("item/started", { threadId: "coder", turnId: turn("coder").id, item: {
    type: "fileChange", id: "patch-outside-move", status: "inProgress", changes: [{
      path: join(cwd, "inside.txt"), kind: { type: "update", move_path: join(process.cwd(), "moved.txt") },
      diff: "@@ -1 +1 @@\n-old\n+new",
    }],
  } });
  fileRequest("outside-move", "coder", undefined);
  fileRequest("grant-root", "coder", [join(cwd, "inside.txt")], { grantRoot: cwd });
  fileRequest("stale-turn", "coder", [join(cwd, "inside.txt")], { turnId: "stale" });
  fileRequest("foreign-thread", "foreign", [join(cwd, "inside.txt")]);
  request("command", "item/commandExecution/requestApproval", {
    threadId: "coder", turnId: turn("coder").id, itemId: "shell-command",
  });
  fileRequest("accept", "coder", [join(cwd, "approve.txt")]);
  fileRequest("decline", "coder", [join(cwd, "decline.txt")]);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (method === "initialize") reply(id, {});
  else if (method === "account/read") reply(id, { account: { type: "chatgpt" } });
  else if (method === "config/read") reply(id, { config: { model_provider: null } });
  else if (method === "model/list") reply(id, { data: [] });
  else if (method === "thread/start") {
    const threadId = ["coordinator", "lead", "coder"][threads.size];
    assert.equal(params.approvalPolicy, threadId === "coder" ? "on-request" : "never");
    threads.set(threadId, params);
    reply(id, { thread: { id: threadId }, modelProvider: "openai" });
  } else if (method === "turn/start") {
    const { threadId } = params;
    assert.equal(params.approvalPolicy, threadId === "coder" ? "on-request" : "never");
    reply(id, { turn: turn(threadId) });
    event("turn/started", { threadId, turn: turn(threadId) });
    if (threadId === "coordinator") {
      fileRequest("coordinator", threadId, [join(process.cwd(), "coordinator.txt")]);
      delegate(threadId, "Test lead", "lead");
    } else if (threadId === "lead") delegate(threadId, "Test coder", "coder");
    else coderRequests();
  } else if (id?.startsWith("delegate-")) {
    assert.equal(result.success, true);
    complete(id.slice("delegate-".length));
  } else if (id && result?.decision) {
    appendFileSync(decisions, JSON.stringify([id, result.decision]) + "\n");
    if (id === "accept") {
      const cwd = threads.get("coder").cwd;
      fileRequest("provider-resolves", "coder", [join(cwd, "expired.txt")]);
      event("serverRequest/resolved", { threadId: "coder", requestId: "provider-resolves" });
      fileRequest("patch-changed", "coder", [join(cwd, "before.txt")]);
      event("item/fileChange/patchUpdated", {
        threadId: "coder", turnId: turn("coder").id, itemId: "patch-patch-changed",
        changes: [{ path: join(cwd, "after.txt"), kind: { type: "add" }, diff: "+ updated" }],
      });
    }
    if (id === "decline") complete("coder");
  }
});
`;

async function waitFor(runtime: WorkspaceRuntime, match: () => boolean) {
  if (match()) return;
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = runtime.subscribe(() => {
      if (!match()) return;
      unsubscribe();
      clearTimeout(timeout);
      resolve();
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Workspace did not reach the expected state: " + JSON.stringify(runtime.snapshot())));
    }, 5_000);
  });
}

test("Codex routes only scoped file changes to the coder chat for approval", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-codex-approval-"));
  const project = join(directory, "project");
  const executable = join(directory, "fixture codex");
  const previousExecutable = process.env.CODEX_BIN;
  let runtime: WorkspaceRuntime | undefined;
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  try {
    git("init", "-q", project);
    git("-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Baseline");
    writeFileSync(executable, "#!" + process.execPath + "\n" + fixture, { mode: 0o700 });
    process.env.CODEX_BIN = executable;
    const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");
    runtime = new WorkspaceRuntime({ cwd: project });
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready");
    await runtime.command({ type: "send", agentId: "coordinator", text: "Start a team" });
    const coder = () => runtime!.snapshot().agents.find((agent) => agent.duty === "coder");
    await waitFor(runtime, () => coder()?.messages.filter((message) => message.approval?.state === "pending").length === 2);
    const agent = coder()!;
    const pending = agent.messages.filter((message) => message.approval?.state === "pending");
    const [approve, decline] = pending;
    assert.equal(agent.status, "attention");
    assert.equal(agent.canSteer, false);
    assert.match(approve.text, /approve\.txt/);
    assert.match(decline.text, /decline\.txt/);
    await assert.rejects(runtime.command({
      type: "approval", agentId: "coordinator", approvalId: approve.id, decision: "accept",
    }), /no longer active/);
    await runtime.command({ type: "approval", agentId: agent.id, approvalId: approve.id, decision: "accept" });
    await assert.rejects(runtime.command({
      type: "approval", agentId: agent.id, approvalId: approve.id, decision: "accept",
    }), /no longer active/);
    await waitFor(runtime, () => coder()?.messages.filter((message) => message.approval?.state === "expired").length === 2);
    const expired = coder()!.messages.filter((message) => message.approval?.state === "expired");
    assert.match(expired[0].text, /expired\.txt/);
    assert.match(expired[1].text, /before\.txt/);
    for (const entry of expired) {
      await assert.rejects(runtime.command({
        type: "approval", agentId: agent.id, approvalId: entry.id, decision: "accept",
      }), /no longer active/);
    }
    await runtime.command({ type: "approval", agentId: agent.id, approvalId: decline.id, decision: "decline" });
    await waitFor(runtime, () => coder()?.status === "awaiting-confirmation");
    assert.deepEqual(coder()!.messages.filter((message) => message.approval).map((message) => message.approval!.state),
      ["accepted", "declined", "expired", "expired"]);
    const replies = new Map(readFileSync(join(directory, "decisions.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as [string, string]));
    assert.equal(replies.get("accept"), "accept");
    for (const id of ["coordinator", "missing-changes", "outside", "git-control", "external-link", "outside-move", "grant-root",
      "stale-turn", "foreign-thread", "command", "patch-changed", "decline"]) {
      assert.equal(replies.get(id), "decline", id);
    }
    assert.equal(replies.has("provider-resolves"), false);
    assert.equal(git("-C", project, "status", "--porcelain"), "");
  } finally {
    if (previousExecutable === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousExecutable;
    if (runtime) {
      await runtime.close();
      const candidate = runtime.snapshot().agents.find((agent) => agent.candidate)?.candidate;
      if (candidate) {
        git("-C", project, "worktree", "remove", "--force", candidate.path);
        rmSync(dirname(candidate.path), { recursive: true, force: true });
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
