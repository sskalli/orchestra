import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceStore, type SavedSession } from "../src/workspace-store.ts";
import type { WorkspaceAgent } from "../src/workspace-runtime.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex-team-reuse.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for team reuse fixture.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  }).trim();
}

function savedAgent(id: string, role: WorkspaceAgent["role"], extra: Partial<WorkspaceAgent> = {}): SavedSession {
  return {
    agent: { id, name: id, role, status: "done", queueDepth: 0, messages: [], canSteer: false, ...extra },
    threadId: role === "coordinator" ? undefined : `${id}-old-thread`,
  };
}

test("archived team reuse migrates legacy identity, starts a fresh coder, and survives reload", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-team-reuse-"));
  const project = join(root, "project");
  const other = join(root, "other");
  const trace = join(root, "trace.jsonl");
  process.env.ORCHESTRA_TEST_TEAM_TRACE = trace;
  const store = workspaceStore(project, join(root, "state"));
  const projects = [{ id: "project", path: project }, { id: "other", path: other }];
  let runtime = new WorkspaceRuntime({ cwd: project, projects, store });
  t.after(async () => {
    const candidates = runtime.snapshot().agents.flatMap((agent) => agent.candidate?.path ? [agent.candidate.path] : []);
    await runtime.close();
    for (const path of new Set(candidates)) {
      if (basename(dirname(path)).startsWith("orchestra-feature-")) rmSync(dirname(path), { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
    delete process.env.ORCHESTRA_TEST_TEAM_TRACE;
  });
  mkdirSync(project);
  mkdirSync(other);
  git(project, "init", "-q");
  writeFileSync(join(project, "README.md"), "Baseline\n");
  git(project, "add", "README.md");
  git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "Baseline");
  const head = git(project, "rev-parse", "HEAD");
  const archiveDate = Date.now() - 10_000;
  store.save([
    savedAgent("coordinator", "coordinator"),
    savedAgent("legacy-lead", "lead", {
      name: "Legacy squad", parentId: "coordinator", projectId: "project", archivedAt: archiveDate, goal: "Maintain the CLI",
    }),
    savedAgent("duplicate-lead", "lead", {
      name: "Legacy squad", parentId: "coordinator", projectId: "other", archivedAt: archiveDate,
    }),
    savedAgent("legacy-coder", "worker", {
      duty: "coder", parentId: "legacy-lead", projectId: "project", archivedAt: archiveDate, goal: "Set up the CLI",
      submissionId: "legacy-submission", submissionFingerprint: "saved-fingerprint",
      messages: [
        { id: "private-old", role: "user", text: "Old transcript marker that must not be restored or copied" },
        { id: "handoff", role: "assistant", text: "Established the CLI interface. " + "x".repeat(2000) },
      ],
    }),
  ]);

  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  const lookup = () => runtime.snapshot().teams?.find((team) => team.id === "legacy-lead");
  const coordinator = () => runtime.snapshot().agents.find((agent) => agent.id === "coordinator");
  const traceEvents = () => readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const team = lookup();
  assert.equal(team?.name, "Legacy squad");
  assert.equal(team?.scope, "Maintain the CLI");
  assert.equal(team?.archivedAt, archiveDate);
  assert.equal(team?.handoff?.summary?.length, 1800);

  await runtime.command({ type: "send", agentId: "coordinator", text: "What did Legacy squad work on?" });
  await waitFor(() => coordinator()?.status === "done");
  assert.equal(runtime.snapshot().agents.length, 4);
  assert(traceEvents().some((event) => event.type === "tool-result" && event.tool === "find_archived_team" &&
    event.result.success === false && /explicitly names/i.test(event.result.contentItems[0].text)));

  await runtime.command({ type: "send", agentId: "coordinator", text: "Use team \"Legacy squad\" to edit README" });
  await waitFor(() => coordinator()?.status === "done");
  assert.equal(runtime.snapshot().agents.length, 4);
  assert(traceEvents().some((event) => event.type === "tool-result" && event.tool === "find_archived_team" &&
    event.result.success === false && /several archived teams/i.test(event.result.contentItems[0].text) &&
    ["legacy-lead", "duplicate-lead"].every((id) => event.result.contentItems[0].text.includes(id))));

  await runtime.command({ type: "send", agentId: "coordinator",
    text: 'Use team "legacy-lead" to edit README in the other repository' });
  await waitFor(() => coordinator()?.status === "done");
  assert.equal(runtime.snapshot().agents.length, 4);
  assert.equal(lookup()?.archivedAt, archiveDate);
  assert(traceEvents().some((event) => event.type === "tool-result" && event.tool === "delegate_agent" &&
    event.result.success === false && /project assigned to the selected team/i.test(event.result.contentItems[0].text)));
  await runtime.command({ type: "delete", agentId: "duplicate-lead" });

  await runtime.command({ type: "send", agentId: "coordinator", text: "Could you reuse the Legacy squad to edit README?" });
  await waitFor(() => coordinator()?.status === "done" &&
    runtime.snapshot().agents.some((agent) => agent.name === "Fresh coder" && agent.status === "done"));
  const fresh = runtime.snapshot().agents.find((agent) => agent.name === "Fresh coder");
  assert(fresh?.candidate);
  assert.equal(fresh.parentId, "coordinator");
  assert.equal(fresh.teamId, "legacy-lead");
  assert.equal(fresh.projectId, "project");
  assert.equal(lookup()?.archivedAt, undefined);
  assert.equal(runtime.snapshot().agents.filter((agent) => agent.role === "lead").length, 1);
  for (const id of ["legacy-lead", "legacy-coder"]) {
    assert.equal(runtime.snapshot().agents.find((agent) => agent.id === id)?.archivedAt, archiveDate);
    assert(!traceEvents().some((event) => event.threadId === `${id}-old-thread`));
  }
  const freshTurn = traceEvents().find((event) => event.type === "turn/start" && event.text === "Implement the next task");
  assert.equal(freshTurn?.context.orchestra_reused_team.kind, "untrusted");
  assert.equal(JSON.parse(freshTurn.context.orchestra_reused_team.value).handoff.summary.length, 1800);
  assert(!JSON.stringify(freshTurn.context).includes("Old transcript marker"));
  assert.equal(runtime.usageExport()?.byTeam["legacy-lead"].tokens?.totalTokens, 20);
  assert.equal(readFileSync(join(fresh.candidate.path, "README.md"), "utf8"), "Fresh candidate\n");
  assert.equal(readFileSync(join(project, "README.md"), "utf8"), "Baseline\n");
  assert.equal(git(project, "rev-parse", "HEAD"), head);
  assert.equal(git(project, "status", "--porcelain"), "");

  await runtime.command({ type: "archive", agentId: fresh.id });
  assert(lookup()?.archivedAt);
  assert.deepEqual(lookup()?.handoff?.paths, ["README.md"]);
  assert.deepEqual(lookup()?.handoff?.sourceRevisions, [{ projectId: "project", revision: head }]);
  await runtime.close();
  runtime = new WorkspaceRuntime({ cwd: project, projects, store });
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert(lookup()?.archivedAt);
  assert.deepEqual(lookup()?.handoff?.paths, ["README.md"]);
  assert.equal(runtime.usageExport()?.byTeam["legacy-lead"].tokens?.totalTokens, 20);
  await runtime.command({ type: "restore", agentId: "legacy-lead" });
  assert.equal(lookup()?.archivedAt, undefined);
  assert(runtime.snapshot().agents.find((agent) => agent.id === fresh.id)?.archivedAt);
  assert(traceEvents().some((event) => event.type === "thread/resume" && event.threadId === "legacy-lead-old-thread"));

  await runtime.command({ type: "archive", agentId: "legacy-lead" });
  await runtime.command({ type: "send", agentId: "coordinator", text: "Use team \"Legacy squad\" to edit README" });
  await waitFor(() => coordinator()?.status === "done" &&
    runtime.snapshot().agents.some((agent) => agent.name === "Fresh coder" && agent.id !== fresh.id && agent.status === "done"));
  const newest = runtime.snapshot().agents.find((agent) => agent.name === "Fresh coder" && agent.id !== fresh.id);
  assert.equal(newest?.teamId, "legacy-lead");
  assert.notEqual(newest?.candidate?.path, fresh.candidate.path);
  assert.equal(runtime.usageExport()?.byTeam["legacy-lead"].tokens?.totalTokens, 40);
});
