import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { fingerprintCandidate, integrateCandidates } from "../src/workspace-integration.ts";
import { createFeatureWorktree } from "../src/workspace-worktree.ts";

function harness(cwd = process.cwd()) {
  const runtime = new WorkspaceRuntime({ cwd, demo: true });
  const internal = runtime as any;
  internal.restore([{ agent: { id: "coordinator", name: "Pilot", role: "coordinator", status: "idle",
    messages: [], queueDepth: 0, canSteer: false } }]);
  const replies = new Map<string, { success: boolean; contentItems: { text: string }[] }>();
  let sequence = 0;
  internal.server = {
    call: async (method: string) => {
      if (method === "thread/start") return { thread: { id: `thread-${++sequence}` }, modelProvider: "openai" };
      if (method === "turn/start") return { turn: { id: `turn-${++sequence}`, status: "inProgress" } };
      throw new Error(`Unexpected fixture RPC ${method}`);
    },
    reply: (id: string, result: any) => replies.set(id, result),
    close: async () => {},
  };
  const create = (id: string, duty?: string, parentId = "coordinator", role = duty ? "worker" : "lead") => {
    const session = internal.createAgent(id, id, role, parentId, "Fixture task");
    session.agent.duty = duty;
    session.threadId = `${id}-thread`;
    internal.threadSessions.set(session.threadId, session);
    return session;
  };
  const call = async (session: any, name: string, args: Record<string, unknown> = {}) => {
    if (!session.run) session.run = { message: { id: "request", role: "user", text: "Fixture" },
      turn: { id: `${session.agent.id}-turn`, status: "inProgress" } };
    session.run.turn ??= { id: `${session.agent.id}-turn`, status: "inProgress" };
    const id = `request-${++sequence}`;
    await internal.onRequest({ id, method: "item/tool/call", params: { threadId: session.threadId,
      turnId: session.run.turn.id, tool: name, arguments: args } });
    const reply = replies.get(id);
    assert(reply, `No reply for ${name}`);
    return { success: reply.success, text: reply.contentItems.map((entry) => entry.text).join("\n") };
  };
  return { runtime, internal, create, call };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();
}

function repository(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-team-test-"));
  try {
    git(directory, "init", "-q");
    writeFileSync(join(directory, "baseline.txt"), "baseline\n");
    git(directory, "add", "baseline.txt");
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "Baseline");
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This execution sandbox blocks Node child_process Git execution (EPERM).");
      return;
    }
    throw error;
  }
  t.after(() => {
    const worktrees = git(directory, "worktree", "list", "--porcelain").split("\n")
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    for (const path of worktrees) {
      if (path === directory) continue;
      git(directory, "worktree", "remove", "--force", path);
      rmSync(dirname(path), { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("lead can inspect and message nested squad members without accessing another team", async () => {
  const { runtime, create, call } = harness();
  const lead = create("lead");
  const coder = create("coder", "coder", "lead");
  const reviewer = create("reviewer", "reviewer", "coder");
  create("other-lead");
  const foreign = create("foreign", "reviewer", "other-lead");
  reviewer.agent.messages.push({ id: "result", role: "assistant", text: "Nested review findings" });
  reviewer.agent.queuePaused = true;
  try {
    const listed = await call(lead, "list_agents");
    assert.equal(listed.success, true);
    const reports = JSON.parse(listed.text);
    assert(reports.some((entry: any) => entry.id === reviewer.agent.id));
    assert(!reports.some((entry: any) => entry.id === foreign.agent.id));
    const report = await call(lead, "read_agent_report", { agentId: reviewer.agent.id });
    assert.equal(report.success, true);
    assert.match(report.text, /Nested review findings/);
    const message = await call(lead, "message_agent", { agentId: reviewer.agent.id, goal: "Recheck accessibility" });
    assert.equal(message.success, true);
    assert.equal(reviewer.queue.at(-1).text, "Recheck accessibility");
    assert.equal((await call(lead, "read_agent_report", { agentId: foreign.agent.id })).success, false);
    assert.equal((await call(lead, "message_agent", { agentId: foreign.agent.id, goal: "Wrong team" })).success, false);
    assert.equal(coder.agent.parentId, "lead");
  } finally { await runtime.close(); }
});

test("coder requests validation as child agents while acceptance and integration stay lead-owned", async () => {
  const { runtime, internal, create, call } = harness();
  const lead = create("lead");
  const coder = create("coder", "coder", "lead");
  coder.agent.candidate = { path: "/fixture/coder-candidate", base: "base" };
  coder.agent.status = "working";
  coder.run = { message: { id: "coding", role: "user", text: "Implement" }, turn: { id: "coder-turn", status: "inProgress" } };
  try {
    for (const duty of ["reviewer", "tester"]) {
      const reply = await call(coder, "delegate_agent", { name: `own-${duty}`, duty, goal: `Check ${duty}` });
      assert.equal(reply.success, true, reply.text);
      const child = internal.sessions.get(JSON.parse(reply.text).id);
      assert.equal(child.agent.parentId, coder.agent.id);
      assert.equal(child.waitingFor, coder.agent.id);
      assert.equal(child.agent.candidate.path, coder.agent.candidate.path);
      assert.equal(child.agent.validationTargetId, coder.agent.id);
    }
    const fromLead = await call(lead, "delegate_agent", { name: "lead-review", duty: "reviewer",
      goal: "Independent review", afterAgentId: coder.agent.id });
    assert.equal(fromLead.success, true, fromLead.text);
    assert.equal(internal.sessions.get(JSON.parse(fromLead.text).id).agent.parentId, coder.agent.id);
    for (const name of ["confirm_implementation", "integrate_candidates", "confirm_integration"]) {
      const reply = await call(coder, name, { agentId: coder.agent.id, agentIds: [coder.agent.id] });
      assert.equal(reply.success, false, name);
    }
    for (const duty of ["coder", "lead", "pm"]) {
      assert.equal((await call(coder, "delegate_agent", { name: "Forbidden", duty, goal: "Wrong role" })).success, false, duty);
    }
  } finally { await runtime.close(); }
});

test("a checker cannot attach its old turn result to a newer coder submission", async () => {
  const { runtime, create, call } = harness();
  create("lead");
  const coder = create("coder", "coder", "lead");
  const reviewer = create("reviewer", "reviewer", "coder");
  coder.agent.candidate = reviewer.agent.candidate = { path: "/fixture/candidate", base: "base" };
  coder.agent.status = "awaiting-confirmation";
  coder.agent.submissionId = "new-submission";
  reviewer.agent.validationTargetId = coder.agent.id;
  reviewer.run = { message: { id: "check", role: "user", text: "Review old version" },
    turn: { id: "reviewer-turn", status: "inProgress" },
    checkTarget: { agentId: coder.agent.id, submissionId: "old-submission", fingerprint: "old-fingerprint" } };
  try {
    const reply = await call(reviewer, "submit_check_result", { outcome: "passed", summary: "Old version looked correct" });
    assert.equal(reply.success, false);
    assert.equal(reviewer.run.check, undefined);
    assert.equal(reviewer.agent.check, undefined);
  } finally { await runtime.close(); }
});

test("integration refuses unaccepted or foreign coder submissions", async () => {
  const { runtime, create, call } = harness();
  const lead = create("lead");
  const coder = create("coder", "coder", "lead");
  create("other-lead");
  const foreign = create("foreign", "coder", "other-lead");
  for (const session of [coder, foreign]) {
    session.agent.status = "awaiting-confirmation";
    session.agent.submissionId = "unaccepted";
    session.agent.submissionFingerprint = "fingerprint";
    session.agent.candidate = { path: "/fixture/candidate", base: "base" };
  }
  try {
    for (const ids of [[coder.agent.id], [foreign.agent.id], [coder.agent.id, foreign.agent.id]]) {
      const result = await call(lead, "integrate_candidates", { agentIds: ids });
      assert.equal(result.success, false, result.text);
      assert.match(result.text, /confirmed|accepted|team/i);
      assert.equal(lead.agent.integration, undefined);
    }
  } finally { await runtime.close(); }
});

test("integration acceptance is lead-only and requires a current integration candidate", async () => {
  const { runtime, create, call } = harness();
  const lead = create("lead");
  const coder = create("coder", "coder", "lead");
  try {
    for (const session of [lead, coder]) {
      const reply = await call(session, "confirm_integration");
      assert.equal(reply.success, false);
      assert.match(reply.text, /lead|integration candidate/i);
    }
  } finally { await runtime.close(); }
});

test("archived validators are excluded from scoped checks and lead reports", async () => {
  const { runtime, internal, create, call } = harness();
  const lead = create("lead");
  const coder = create("coder", "coder", "lead");
  const reviewer = create("reviewer", "reviewer", "coder");
  const tester = create("tester", "tester", "coder");
  coder.agent.candidate = reviewer.agent.candidate = tester.agent.candidate = { path: "/fixture/candidate", base: "base" };
  for (const checker of [reviewer, tester]) checker.agent.validationTargetId = coder.agent.id;
  try {
    assert.equal(internal.scopedChecks(coder).length, 2);
    await runtime.command({ type: "archive", agentId: reviewer.agent.id });
    assert.deepEqual(internal.scopedChecks(coder).map((entry: any) => entry.agent.id), [tester.agent.id]);
    const reports = await call(lead, "list_agents");
    assert.equal(reports.success, true);
    assert(!JSON.parse(reports.text).some((entry: any) => entry.id === reviewer.agent.id));
    assert.equal((await call(lead, "read_agent_report", { agentId: reviewer.agent.id })).success, false);
  } finally { await runtime.close(); }
});

test("a queued checker with a missing target fails visibly instead of rejecting outside the command", async () => {
  const { runtime, create } = harness();
  create("lead");
  const tester = create("tester", "tester", "lead");
  tester.agent.validationTargetId = "removed-target";
  const queued = { id: "queued-check", role: "user", text: "Run the stale check", state: "queued" };
  tester.agent.messages.push(queued);
  tester.queue.push(queued);
  tester.agent.queueDepth = 1;
  tester.agent.queuePaused = true;
  try {
    await runtime.command({ type: "resumeQueue", agentId: tester.agent.id });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(tester.agent.status, "error");
    assert.equal(queued.state, "failed");
    assert.equal(tester.run, undefined);
    assert(tester.agent.messages.some((entry: any) => entry.role === "system" && /validation target|fresh check/i.test(entry.text)));
  } finally { await runtime.close(); }
});

test("multiple coders receive distinct worktrees and the lead keeps the project checkout", async (t) => {
  const project = repository(t);
  if (!project) return;
  const { runtime, create, call } = harness(project);
  const lead = create("lead");
  try {
    const candidates: string[] = [];
    for (const name of ["homepage", "settings"]) {
      const reply = await call(lead, "delegate_agent", { name, duty: "coder", goal: `Implement ${name}` });
      assert.equal(reply.success, true, reply.text);
      const agent = runtime.snapshot().agents.find((entry) => entry.id === JSON.parse(reply.text).id)!;
      assert(agent.candidate);
      candidates.push(agent.candidate.path);
      assert.equal(agent.parentId, lead.agent.id);
    }
    assert.notEqual(candidates[0], candidates[1]);
    assert.equal(lead.agent.candidate, undefined);
    assert.equal(git(project, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(project, "baseline.txt"), "utf8"), "baseline\n");
  } finally { await runtime.close(); }
});

test("integration snapshots dirty candidates without changing their indexes or the project branch", (t) => {
  const project = repository(t);
  if (!project) return;
  writeFileSync(join(project, "remove-me.txt"), "old\n");
  git(project, "add", "remove-me.txt");
  git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Removal fixture");
  const first = createFeatureWorktree(project);
  const second = createFeatureWorktree(project);
  writeFileSync(join(first.path, "feature-a.txt"), "staged version\n");
  git(first.path, "add", "feature-a.txt");
  writeFileSync(join(first.path, "feature-a.txt"), "final working version\n");
  rmSync(join(second.path, "remove-me.txt"));
  writeFileSync(join(second.path, "feature-b.txt"), "untracked feature\n");
  const before = [first, second].map((source) => ({ head: git(source.path, "rev-parse", "HEAD"),
    index: git(source.path, "write-tree"), status: git(source.path, "status", "--porcelain") }));
  const projectHead = git(project, "rev-parse", "HEAD");
  const sources = [first, second].map((source, index) => ({ ...source, agentId: `coder-${index + 1}`,
    submissionId: `submission-${index + 1}`, expectedFingerprint: fingerprintCandidate(source.path) }));
  const integration = integrateCandidates(project, sources);
  assert.notEqual(integration.path, first.path);
  assert.notEqual(integration.path, second.path);
  assert.equal(readFileSync(join(integration.path, "feature-a.txt"), "utf8"), "final working version\n");
  assert.equal(readFileSync(join(integration.path, "feature-b.txt"), "utf8"), "untracked feature\n");
  assert.throws(() => readFileSync(join(integration.path, "remove-me.txt")), /ENOENT/);
  assert.equal(integration.fingerprint, fingerprintCandidate(integration.path));
  assert.deepEqual(integration.sources.map((source) => source.submissionId), sources.map((source) => source.submissionId));
  assert.equal(git(project, "rev-parse", "HEAD"), projectHead);
  assert.equal(git(project, "status", "--porcelain"), "");
  [first, second].forEach((source, index) => assert.deepEqual({ head: git(source.path, "rev-parse", "HEAD"),
    index: git(source.path, "write-tree"), status: git(source.path, "status", "--porcelain") }, before[index]));
  writeFileSync(join(first.path, "feature-a.txt"), "changed after acceptance\n");
  assert.throws(() => integrateCandidates(project, sources), /changed since acceptance/i);
});

test("conflicting integration preserves sources and cleans up only its newly created candidate", (t) => {
  const project = repository(t);
  if (!project) return;
  const first = createFeatureWorktree(project);
  const second = createFeatureWorktree(project);
  writeFileSync(join(first.path, "baseline.txt"), "first competing change\n");
  writeFileSync(join(second.path, "baseline.txt"), "second competing change\n");
  const worktrees = git(project, "worktree", "list", "--porcelain");
  assert.throws(() => integrateCandidates(project, [first, second].map((source, index) => ({
    ...source, agentId: `coder-${index}`, submissionId: `submission-${index}`, expectedFingerprint: fingerprintCandidate(source.path),
  }))), /conflict|failed Git application/i);
  assert.equal(git(project, "worktree", "list", "--porcelain"), worktrees);
  assert.equal(readFileSync(join(first.path, "baseline.txt"), "utf8"), "first competing change\n");
  assert.equal(readFileSync(join(second.path, "baseline.txt"), "utf8"), "second competing change\n");
  assert.equal(readFileSync(join(project, "baseline.txt"), "utf8"), "baseline\n");
  assert.equal(git(project, "status", "--porcelain"), "");
});

test("check turns capture the exact candidate at begin and reject changes before submission or completion", async (t) => {
  const project = repository(t);
  if (!project) return;
  const { runtime, internal, create, call } = harness(project);
  create("lead");
  const coder = create("coder", "coder", "lead");
  const checker = create("reviewer", "reviewer", "coder");
  const candidate = createFeatureWorktree(project);
  coder.agent.candidate = checker.agent.candidate = candidate;
  coder.agent.status = "awaiting-confirmation";
  coder.agent.submissionId = "submission-1";
  coder.agent.submissionFingerprint = fingerprintCandidate(candidate.path);
  checker.agent.validationTargetId = coder.agent.id;
  try {
    await internal.begin(checker, { id: "review-1", role: "user", text: "Review" });
    assert.deepEqual(checker.run.checkTarget, { agentId: "coder", submissionId: "submission-1",
      fingerprint: coder.agent.submissionFingerprint });
    writeFileSync(join(candidate.path, "new-change.txt"), "changed while checking\n");
    const stale = await call(checker, "submit_check_result", { outcome: "passed", summary: "Stale review" });
    assert.equal(stale.success, false);
    assert.equal(checker.run.check, undefined);
    clearTimeout(checker.run.demoTimer);
    internal.finish(checker, false);
    coder.agent.submissionId = "submission-2";
    coder.agent.submissionFingerprint = fingerprintCandidate(candidate.path);
    await internal.begin(checker, { id: "review-2", role: "user", text: "Review updated submission" });
    const accepted = await call(checker, "submit_check_result", { outcome: "passed", summary: "Checked exact version" });
    assert.equal(accepted.success, true, accepted.text);
    writeFileSync(join(candidate.path, "new-change.txt"), "changed after check report\n");
    clearTimeout(checker.run.demoTimer);
    internal.onEvent({ method: "turn/completed", params: { threadId: checker.threadId,
      turn: { id: checker.run.turn.id, status: "completed" } } });
    assert.equal(checker.agent.check, undefined, "late completion must not publish obsolete passing evidence");
  } finally { await runtime.close(); }
});

test("integration acceptance needs fresh independent combined-snapshot testing and source changes invalidate it", async (t) => {
  const project = repository(t);
  if (!project) return;
  const { runtime, internal, create, call } = harness(project);
  const lead = create("lead");
  const first = create("coder-1", "coder", "lead");
  const second = create("coder-2", "coder", "lead");
  for (const [index, coder] of [first, second].entries()) {
    coder.agent.candidate = createFeatureWorktree(project);
    writeFileSync(join(coder.agent.candidate.path, `feature-${index}.txt`), `feature ${index}\n`);
    coder.agent.status = "done";
    coder.agent.submissionId = `submission-${index}`;
    coder.agent.submissionFingerprint = fingerprintCandidate(coder.agent.candidate.path);
  }
  const baseline = git(project, "rev-parse", "HEAD");
  try {
    const combined = await call(lead, "integrate_candidates", { agentIds: [first.agent.id, second.agent.id] });
    assert.equal(combined.success, true, combined.text);
    const integration = lead.agent.integration;
    assert(integration);
    assert.equal((await call(lead, "confirm_integration")).success, false, "feature checks cannot substitute for combined testing");
    const featureTester = create("feature-tester", "tester", first.agent.id);
    featureTester.agent.candidate = first.agent.candidate;
    featureTester.agent.validationTargetId = first.agent.id;
    featureTester.agent.check = { submissionId: first.agent.submissionId, targetAgentId: first.agent.id,
      candidateFingerprint: first.agent.submissionFingerprint, outcome: "passed", summary: "Feature passed", recordedAt: Date.now() };
    assert.equal((await call(lead, "confirm_integration")).success, false);
    const tester = create("integration-tester", "tester", lead.agent.id);
    tester.agent.candidate = { path: integration.path, base: integration.base };
    tester.agent.validationTargetId = lead.agent.id;
    await internal.begin(tester, { id: "integration-test", role: "user", text: "Execute combined acceptance checks" });
    assert.deepEqual(tester.run.checkTarget, { agentId: lead.agent.id, submissionId: integration.id, fingerprint: integration.fingerprint });
    const report = await call(tester, "submit_check_result", { outcome: "passed", summary: "Combined acceptance checks executed and passed" });
    assert.equal(report.success, true, report.text);
    assert.equal((await call(lead, "confirm_integration")).success, false, "tester must finish its turn before acceptance");
    clearTimeout(tester.run.demoTimer);
    internal.onEvent({ method: "turn/completed", params: { threadId: tester.threadId,
      turn: { id: tester.run.turn.id, status: "completed" } } });
    assert.equal(tester.agent.check.submissionId, integration.id);
    const accepted = await call(lead, "confirm_integration");
    assert.equal(accepted.success, true, accepted.text);
    assert.equal(integration.confirmed, true);
    assert.equal(git(project, "rev-parse", "HEAD"), baseline);
    assert.equal(git(project, "status", "--porcelain"), "");
    writeFileSync(join(integration.path, "changed-combined.txt"), "unvalidated combined change\n");
    const staleCombined = await call(lead, "confirm_integration");
    assert.equal(staleCombined.success, false);
    assert.match(staleCombined.text, /snapshot changed|fresh|rebuild|test/i);
    rmSync(join(integration.path, "changed-combined.txt"));
    writeFileSync(join(first.agent.candidate.path, "feature-0.txt"), "source changed after acceptance\n");
    const staleSource = await call(lead, "confirm_integration");
    assert.equal(staleSource.success, false);
    assert.match(staleSource.text, /source|changed|revalidat|fresh/i);
    assert.equal(git(project, "rev-parse", "HEAD"), baseline);
    assert.equal(git(project, "status", "--porcelain"), "");
  } finally { await runtime.close(); }
});
