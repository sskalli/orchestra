import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";
import { resolveTeamReuseRequest } from "../src/workspace-teams.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function crossRepoFixture(t: TestContext, sources: Record<string, string> = {
  api: "export default null;\n",
  ui: "export default null;\n",
  other: "export default null;\n",
}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-cross-repo-"));
  const projects = Object.keys(sources).map((id) => ({ id, path: join(root, id) }));
  const initialized: string[] = [];
  t.after(() => {
    for (const project of initialized) {
      const paths = git(project, "worktree", "list", "--porcelain").split("\n")
        .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
      for (const path of paths) {
        if (path === project) continue;
        git(project, "worktree", "remove", "--force", path);
        if (basename(dirname(path)).startsWith("orchestra-feature-")) rmSync(dirname(path), { recursive: true, force: true });
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const project of projects) {
    mkdirSync(project.path);
    try {
      git(project.path, "init", "-q");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip("This execution sandbox blocks spawning Git from Node (EPERM).");
      return;
    }
    initialized.push(project.path);
    writeFileSync(join(project.path, "index.mjs"), sources[project.id]);
    writeFileSync(join(project.path, ".gitignore"), "ignored-local.txt\n");
    git(project.path, "add", "index.mjs", ".gitignore");
    git(project.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Baseline");
  }
  const baseline = projects.map(({ path }) => git(path, "rev-parse", "HEAD"));
  const runtime = new WorkspaceRuntime({ cwd: projects[0].path, projects });
  t.after(() => runtime.close());
  const internal = runtime as any;
  internal.setProvider("ready");
  let sequence = 0;
  const requests: { method: string; params: any }[] = [];
  const replies = new Map<string, { success: boolean; contentItems: { text: string }[] }>();
  internal.server = {
    call: async (method: string, params: any) => {
      requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: `thread-${++sequence}` }, modelProvider: "openai" };
      if (method === "turn/start") return { turn: { id: `turn-${++sequence}`, status: "inProgress" } };
      throw new Error(`Unexpected fixture RPC ${method}`);
    },
    reply: (id: string, value: any) => replies.set(id, value),
    close: async () => {},
  };
  const coordinator = internal.sessions.get("coordinator");
  coordinator.threadId = "pilot-thread";
  internal.threadSessions.set(coordinator.threadId, coordinator);
  const call = async (session: any, name: string, args: object = {}) => {
    session.run ??= {
      message: { id: `message-${++sequence}`, role: "user", text: "Fixture task" },
      turn: { id: `turn-${++sequence}`, status: "inProgress" },
    };
    const id = `request-${++sequence}`;
    await internal.onRequest({ id, method: "item/tool/call", params: {
      threadId: session.threadId, turnId: session.run.turn.id, tool: name, arguments: args,
    } });
    const reply = replies.get(id);
    assert(reply, `No reply for ${name}`);
    return { success: reply.success, text: reply.contentItems[0].text };
  };
  const complete = (session: any) => internal.onEvent({ method: "turn/completed", params: {
    threadId: session.threadId, turn: { id: session.run.turn.id, status: "completed" },
  } });
  const delegate = (session: any, duty: string, details = {}) =>
    call(session, "delegate_agent", { name: duty, duty, goal: "Fixture task", ...details });
  const sessionFrom = (reply: { success: boolean; text: string }) => {
    assert.equal(reply.success, true, reply.text);
    return internal.sessions.get(JSON.parse(reply.text).id);
  };

  return { root, projects, baseline, runtime, internal, requests, coordinator, call, complete, delegate, sessionFrom };
}

test("cross-repo delivery pins the API and UI, enforces repo scope and requires fresh joint evidence", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, projects, baseline, runtime, requests, coordinator, call, complete, delegate, sessionFrom } = fixture;

  const lead = sessionFrom(await delegate(coordinator, "lead", { projectIds: ["api", "ui"] }));
  assert.deepEqual(runtime.snapshot().teams?.find((team) => team.id === lead.agent.teamId)?.projectIds, ["api", "ui"]);
  assert.equal((await delegate(lead, "coder")).success, false, "multi-repo assignment requires a project");
  assert.equal((await delegate(lead, "coder", { projectId: "other" })).success, false, "lead cannot use an unassigned repo");
  const api = sessionFrom(await delegate(lead, "coder", { projectId: "api" }));
  const ui = sessionFrom(await delegate(lead, "coder", { projectId: "ui" }));
  assert.equal(api.agent.projectId, "api");
  assert.equal(ui.agent.projectId, "ui");
  writeFileSync(join(api.agent.candidate.path, "index.mjs"), "export default { label: 'ready' };\n");
  writeFileSync(join(ui.agent.candidate.path, "index.mjs"), "export default (payload) => payload.label.toUpperCase();\n");
  complete(api);
  complete(ui);
  assert.equal((await delegate(lead, "reviewer", { afterAgentId: ui.agent.id, projectId: "api" })).success, false);
  const reviewer = sessionFrom(await delegate(lead, "reviewer", { afterAgentId: ui.agent.id }));
  assert.equal(reviewer.agent.projectId, "ui");
  assert.equal((await call(reviewer, "submit_check_result", { outcome: "passed", summary: "Reviewed UI candidate" })).success, true);
  complete(reviewer);
  for (const coder of [api, ui]) {
    const reply = await call(lead, "confirm_implementation", { agentId: coder.agent.id });
    assert.equal(reply.success, true, reply.text);
  }
  const integrate = () => call(lead, "integrate_candidates", { agentIds: [api.agent.id, ui.agent.id] });
  const integration = await integrate();
  assert.equal(integration.success, true, integration.text);
  const manifest = JSON.parse(integration.text);
  assert.deepEqual(manifest.members.map(({ projectId }: { projectId: string }) => projectId).sort(), ["api", "ui"]);
  const confirm = () => call(lead, "confirm_integration");
  assert.equal((await confirm()).success, false, "must have independent evidence");
  const tester = sessionFrom(await delegate(lead, "tester"));
  const testRequest = requests.findLast(({ method }) => method === "turn/start")?.params;
  const paths = manifest.members.map(({ path }: { path: string }) => path);
  assert.deepEqual([...testRequest.runtimeWorkspaceRoots].sort(), [...paths].sort());
  assert.equal(testRequest.sandboxPolicy.type, "readOnly");
  assert.equal(testRequest.approvalPolicy, "never");
  assert(!testRequest.runtimeWorkspaceRoots.includes(projects[0].path));
  const apiPath = manifest.members.find(({ projectId }: { projectId: string }) => projectId === "api").path;
  const uiPath = manifest.members.find(({ projectId }: { projectId: string }) => projectId === "ui").path;
  assert.notEqual(apiPath, api.agent.candidate.path);
  assert.notEqual(uiPath, ui.agent.candidate.path);
  execFileSync(process.execPath, ["--input-type=module", "-e", "import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; const [api, ui] = await Promise.all(process.argv.slice(1).map(path => import(pathToFileURL(path).href))); assert.equal(ui.default(api.default), 'READY');", join(apiPath, "index.mjs"), join(uiPath, "index.mjs")]);
  assert.equal((await call(tester, "submit_check_result", { outcome: "passed", summary: "Pinned API output renders as READY" })).success, true);
  complete(tester);
  const accepted = await confirm();
  assert.equal(accepted.success, true, accepted.text);
  assert.equal(lead.agent.integration.confirmed, true);

  const failedTester = sessionFrom(await delegate(lead, "tester"));
  assert.equal((await call(failedTester, "submit_check_result", {
    outcome: "changes-requested", summary: "Independent recheck failed",
  })).success, true);
  complete(failedTester);
  await runtime.command({ type: "archive", agentId: failedTester.agent.id });
  assert.equal((await confirm()).success, false, "archiving a failed recheck cannot expose an earlier passing report");
  assert.notEqual(lead.agent.integration.confirmed, true, "a failed recheck clears the acceptance state");
  const freshTester = sessionFrom(await delegate(lead, "tester"));
  assert.equal((await call(freshTester, "submit_check_result", {
    outcome: "passed", summary: "Fresh joint verification passed",
  })).success, true);
  complete(freshTester);
  assert.equal((await confirm()).success, true);

  const store = workspaceStore(root, join(root, "state"));
  const snapshot = runtime.snapshot();
  store.save(snapshot.agents.map((agent) => ({ agent })), snapshot.teams);
  const persisted = store.loadWorkspace();
  assert(persisted);
  const reopened = new WorkspaceRuntime({ cwd: projects[0].path, projects, store });
  t.after(() => reopened.close());
  (reopened as any).restore(persisted.sessions, persisted.teams);
  assert.deepEqual(reopened.snapshot().teams?.find((team) => team.id === lead.agent.teamId)?.projectIds, ["api", "ui"]);
  assert.deepEqual(reopened.snapshot().agents.find((agent) => agent.id === lead.agent.id)?.integration, lead.agent.integration);
  assert.equal(reopened.snapshot().agents.find((agent) => agent.id === ui.agent.id)?.projectId, "ui");

  writeFileSync(join(uiPath, "index.mjs"), "export default () => 'stale';\n");
  assert.equal((await confirm()).success, false, "changing either repo makes the old check stale");
  for (const [index, { path }] of projects.entries()) {
    assert.equal(git(path, "rev-parse", "HEAD"), baseline[index]);
    assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(path, "index.mjs"), "utf8"), "export default null;\n");
  }
});


test("the pilot delivers a cohesive API/UI change with one coder and clean isolated worktrees", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, projects, baseline, runtime, internal, requests, coordinator, call, complete, delegate, sessionFrom } = fixture;
  const goal = "Return {message:'ready'} from the API; render READY in the UI; run the joint response check.";
  const projectIds = ["api", "ui"];
  assert.equal((await delegate(coordinator, "coder", { projectIds: ["api", "other-unknown"] })).success, false);
  assert.equal((await delegate(coordinator, "coder", { projectIds: ["api", "api"] })).success, false);
  assert.equal((await delegate(coordinator, "coder", { projectId: "other", projectIds })).success, false);
  assert.equal((await delegate(coordinator, "coder", { projectIds, requiredChecks: ["tester"] })).success, false);
  assert.equal(runtime.snapshot().agents.length, 1, "invalid inputs must not start a coder");

  const coder = sessionFrom(await delegate(coordinator, "coder", { goal, projectIds, requiredChecks: [] }));
  const candidates: { projectId: string; path: string; base: string }[] = coder.agent.directCandidates;
  assert.deepEqual(candidates.map(({ projectId }) => projectId), projectIds);
  assert.equal(runtime.snapshot().agents.length, 2);
  assert.equal(coder.agent.parentId, coordinator.agent.id);
  const request = requests.findLast(({ method }) => method === "turn/start")?.params;
  const paths = candidates.map(({ path }) => path).sort();
  assert.deepEqual([...request.runtimeWorkspaceRoots].sort(), paths);
  assert.equal(request.sandboxPolicy.type, "workspaceWrite");
  assert.equal(request.approvalPolicy, "never");
  assert.deepEqual([...request.sandboxPolicy.writableRoots].sort(), paths);
  assert.equal(request.input.filter(({ type }: { type: string }) => type === "text").length, 1);
  assert.match(request.input[0].text, /Return \{message:'ready'\}/);
  assert(!JSON.stringify(request.input).includes(projects[2].path));
  assert.equal(request.additionalContext, undefined);

  for (const [index, candidate] of candidates.entries()) {
    assert.notEqual(candidate.path, projects[index].path);
    assert.equal(candidate.base, baseline[index]);
    writeFileSync(join(candidate.path, "ignored-local.txt"), "coder residue\n");
  }
  const [api, ui] = candidates;
  const uiSource = "export const display = (value) => value.message.toUpperCase();\n";
  writeFileSync(join(api.path, "index.mjs"), "export const payload = () => ({message:'ready'});\n");
  writeFileSync(join(ui.path, "index.mjs"), uiSource);
  const check = (apiPath: string, uiPath: string) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const [api, ui] = await Promise.all(process.argv.slice(1).map(path => import(pathToFileURL(path).href)));
      assert.deepEqual(api.payload(), { message: 'ready' });
      assert.equal(ui.display(api.payload()), 'READY');
    `, join(apiPath, "index.mjs"), join(uiPath, "index.mjs")]);
  check(api.path, ui.path);
  internal.onEvent({ method: "item/completed", params: {
    threadId: coder.threadId, turnId: coder.run.turn.id,
    item: { type: "agentMessage", id: "joint-report", text: "API and UI updated. Joint response check passed." },
  } });
  complete(coder);
  assert.equal(coder.agent.status, "awaiting-confirmation");
  const report = await call(coordinator, "read_agent_report", { agentId: coder.agent.id });
  assert.equal(report.success, true, report.text);
  assert.match(report.text, /Joint response check passed/);
  const confirm = () => call(coordinator, "confirm_implementation", { agentId: coder.agent.id });
  writeFileSync(join(ui.path, "index.mjs"), "export const display = () => 'STALE';\n");
  const stale = await confirm();
  assert.equal(stale.success, false, "a change in the second repo invalidates the entire submission");
  assert.equal(coder.agent.integration, undefined);
  writeFileSync(join(ui.path, "index.mjs"), uiSource);
  const accepted = await confirm();
  assert.equal(accepted.success, true, accepted.text);
  assert.equal(coder.agent.status, "done");
  const delivery = coder.agent.integration;
  assert(delivery?.confirmed);
  assert.deepEqual(delivery.members.map(({ projectId }: { projectId: string }) => projectId).sort(), projectIds);
  const apiDelivery = delivery.members.find(({ projectId }: { projectId: string }) => projectId === "api");
  const uiDelivery = delivery.members.find(({ projectId }: { projectId: string }) => projectId === "ui");
  check(apiDelivery.path, uiDelivery.path);
  for (const candidate of candidates) {
    const member = delivery.members.find(({ projectId }: { projectId: string }) => projectId === candidate.projectId);
    assert.notEqual(member.path, candidate.path);
    assert.equal(member.revision, git(member.path, "rev-parse", "HEAD"));
    assert.equal(member.base, candidate.base);
    assert.equal(git(member.path, "status", "--porcelain"), "");
    assert.equal(existsSync(join(member.path, "ignored-local.txt")), false);
    assert.equal(existsSync(join(candidate.path, "ignored-local.txt")), true);
  }
  for (const [index, { path }] of projects.entries()) {
    assert.equal(git(path, "rev-parse", "HEAD"), baseline[index]);
    assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(path, "index.mjs"), "utf8"), "export default null;\n");
  }

  const store = workspaceStore(root, join(root, "state"));
  const snapshot = runtime.snapshot();
  store.save(snapshot.agents.map((agent) => ({ agent })), snapshot.teams);
  const persisted = store.loadWorkspace();
  assert(persisted);
  const reopened = new WorkspaceRuntime({ cwd: projects[0].path, projects, store });
  t.after(() => reopened.close());
  (reopened as any).restore(persisted.sessions, persisted.teams);
  const savedCoder = reopened.snapshot().agents.find((agent) => agent.id === coder.agent.id);
  assert.deepEqual(savedCoder?.directCandidates, candidates);
  assert.deepEqual(savedCoder?.integration, delivery);
});


test("archived cross-repo teams can send the compact handoff to one fresh coder", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, requests, coordinator, call, complete, delegate, sessionFrom } = fixture;
  const lead = sessionFrom(await delegate(coordinator, "lead", { name: "Contact Form", projectIds: ["api", "ui"] }));
  complete(lead);
  await runtime.command({ type: "archive", agentId: lead.agent.id });

  const prompt = "Reuse team Contact Form to edit the API and UI";
  const teams = runtime.snapshot().teams ?? [];
  assert(teams.find(({ id }) => id === lead.agent.id)?.archivedAt);
  coordinator.run.message.text = prompt;
  coordinator.run.reuseRequest = resolveTeamReuseRequest(prompt, teams);
  coordinator.run.delegated = false;
  const selection = await call(coordinator, "find_archived_team", { name: lead.agent.id });
  assert.equal(selection.success, true, selection.text);

  const coder = sessionFrom(await delegate(coordinator, "coder", { projectIds: ["ui", "api"] }));
  const [ui, api] = coder.agent.directCandidates;
  assert.equal(coder.agent.teamId, lead.agent.id);
  assert.equal(coder.agent.projectId, "ui");
  assert.equal(ui.projectId, "ui");
  assert.equal(api.projectId, "api");
  const request = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(request.cwd, ui.path);
  assert.equal(JSON.parse(request.additionalContext.orchestra_reused_team.value).id, lead.agent.id);

  writeFileSync(join(api.path, "index.mjs"), "export const payload = () => ({message:'ready'});\n");
  writeFileSync(join(ui.path, "index.mjs"), "export const display = (value) => value.message.toUpperCase();\n");
  internal.onEvent({ method: "item/completed", params: {
    threadId: coder.threadId, turnId: coder.run.turn.id,
    item: { type: "agentMessage", id: "joint-report", text: "API and UI updated." },
  } });
  complete(coder);
  const accepted = await call(coordinator, "confirm_implementation", { agentId: coder.agent.id });
  assert.equal(accepted.success, true, accepted.text);
  await runtime.command({ type: "archive", agentId: coder.agent.id });
  const archived = runtime.snapshot().teams?.find(({ id }) => id === lead.agent.id);
  assert(archived?.archivedAt);
  assert.deepEqual(archived.handoff?.paths?.sort(), ["api/index.mjs", "ui/index.mjs"]);
  assert.deepEqual(archived.handoff?.sourceRevisions?.map(({ projectId, revision }) => [projectId, revision]).sort(),
    coder.agent.integration.members.map(({ projectId, revision }: { projectId: string; revision: string }) => [projectId, revision]).sort());
});

test("one approval continues the stale-status investigation in an isolated adapter candidate", async (t) => {
  const fixture = crossRepoFixture(t, {
    dashboard: "export const statusLabel = ({ status }) => `Status: ${status}`;\n",
    "local-service": "export const getStatus = (readStatus, source) => readStatus(source);\n",
    adapter: "const statuses = { west: 'online', east: 'offline' };\nlet cached;\nexport const readStatus = (source) => cached ??= { status: statuses[source] };\n",
  });
  if (!fixture) return;
  const { root, projects, baseline, runtime, internal, requests, coordinator, call, complete, delegate, sessionFrom } = fixture;
  const store = workspaceStore(root, join(root, "state"));
  internal.store = store;
  internal.storageReady = true;
  const [dashboard, service, adapter] = projects;
  const investigation = sessionFrom(await delegate(coordinator, "analyser", {
    name: "Stale status investigation", projectId: dashboard.id,
  }));
  const brief = "Remove the shared adapter cache. Check west→east and east→west through the local service and dashboard.";
  const tool = "raise_product_decision";
  const question = "Approve reading the selected source on every request?";
  assert.equal((await call(investigation, tool, { question })).success, true);
  assert.equal(investigation.agent.implementationProposal, undefined, "a generic question must remain a discussion");
  assert.equal((await call(investigation, tool, { question, implementation: { projectId: "missing", brief } })).success, false);
  const proposal = await call(investigation, tool, { question, implementation: { projectId: adapter.id, brief } });
  assert.equal(proposal.success, true, proposal.text);
  complete(investigation);

  const getTask = () => runtime.snapshot().agents.find((agent) => agent.id === investigation.agent.id)!;
  const pending = getTask().implementationProposal;
  assert.equal(pending?.status, "awaiting-approval");
  assert.equal(pending.projectId, adapter.id);
  const saved = store.loadWorkspace();
  assert(saved);
  assert.deepEqual(saved.sessions.find(({ agent }) => agent.id === investigation.agent.id)?.agent.implementationProposal, pending);
  assert.equal(runtime.snapshot().agents.filter((agent) => agent.duty === "coder").length, 0);
  assert.equal(git(adapter.path, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  assert(runtime.snapshot().agents.find((agent) => agent.id === coordinator.agent.id)?.messages.some((message) =>
    message.sourceAgentId === investigation.agent.id && message.implementationProposalId === pending.id));

  const approval = { type: "approveImplementation" as const, agentId: investigation.agent.id, proposalId: pending.id };
  await assert.rejects(runtime.command({ ...approval, proposalId: "wrong-proposal" }));
  const approvals = await Promise.allSettled([runtime.command(approval), runtime.command(approval)]);
  assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(getTask().implementationProposal?.status, "implementing");
  const coders = runtime.snapshot().agents.filter((agent) => agent.duty === "coder");
  assert.equal(coders.length, 1);
  const coder = internal.sessions.get(coders[0].id);
  assert.equal(coder.agent.parentId, investigation.agent.id);
  assert.equal(coder.agent.projectId, adapter.id);
  const candidate = coder.agent.candidate.path;
  assert.notEqual(candidate, adapter.path);
  const turn = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [candidate]);
  assert(JSON.stringify(turn.input).includes(brief));

  const check = (adapterPath: string, expected: "pass" | "fail") => {
    const script = `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const [dashboard, service, adapter] = process.argv.slice(1).map(path => pathToFileURL(path).href);
      const { statusLabel } = await import(dashboard);
      const { getStatus } = await import(service);
      for (const order of [['west', 'east'], ['east', 'west']]) {
        const { readStatus } = await import(adapter + '?' + order[0]);
        for (const source of order) {
          const expected = source === 'west' ? 'online' : 'offline';
          assert.equal(statusLabel(getStatus(readStatus, source)), 'Status: ' + expected);
        }
      }
    `;
    const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", script,
      join(dashboard.path, "index.mjs"), join(service.path, "index.mjs"), join(adapterPath, "index.mjs")],
    { stdio: ["ignore", "pipe", "pipe"] });
    if (expected === "fail") assert.throws(run, /ERR_ASSERTION/);
    else run();
  };
  check(adapter.path, "fail");
  const candidateFile = join(candidate, "index.mjs");
  const fixedAdapter = "const statuses = { west: 'online', east: 'offline' };\nexport const readStatus = (source) => ({ status: statuses[source] });\n";
  writeFileSync(candidateFile, fixedAdapter);
  check(candidate, "pass");
  const verification = "Both west→east and east→west passed through the service and dashboard.";
  const reportCheck = async () => {
    const reply = await call(coder, "submit_check_result", { outcome: "passed", summary: verification });
    assert.equal(reply.success, true, reply.text);
  };
  await reportCheck();
  writeFileSync(candidateFile, fixedAdapter + "\n");
  complete(coder);
  const blocked = getTask().implementationProposal;
  assert.equal(blocked?.status, "blocked", "evidence for a prior checkout cannot mark the task ready");
  assert.equal(blocked.coderId, coder.agent.id);
  assert.equal(blocked.candidateRevision, undefined);

  await runtime.command({ type: "send", agentId: coder.agent.id, text: "Rerun the checks on the final candidate." });
  assert.equal(getTask().implementationProposal?.status, "implementing");
  check(candidate, "pass");
  await reportCheck();
  internal.onEvent({ method: "item/completed", params: {
    threadId: coder.threadId, turnId: coder.run.turn.id,
    item: { type: "agentMessage", id: "bug-checks", text: verification },
  } });
  complete(coder);

  const delivery = getTask().implementationProposal;
  assert.equal(delivery?.status, "ready-for-review");
  assert.equal(delivery.coderId, coder.agent.id);
  assert(delivery.candidatePath);
  assert.notEqual(delivery.candidatePath, candidate);
  assert.equal(delivery.candidateRevision, git(delivery.candidatePath, "rev-parse", "HEAD"));
  assert.equal(git(delivery.candidatePath, "status", "--porcelain"), "");
  check(delivery.candidatePath, "pass");
  const savedDelivery = store.loadWorkspace();
  assert(savedDelivery);
  const reopened = new WorkspaceRuntime({ cwd: dashboard.path, projects, store });
  t.after(() => reopened.close());
  (reopened as any).restore(savedDelivery.sessions, savedDelivery.teams);
  assert.deepEqual(reopened.snapshot().agents.find((agent) => agent.id === investigation.agent.id)?.implementationProposal,
    delivery);
  for (const [index, { path }] of projects.entries()) {
    assert.equal(git(path, "rev-parse", "HEAD"), baseline[index]);
    assert.equal(git(path, "status", "--porcelain"), "");
  }
});
