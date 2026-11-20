import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("cross-repo delivery pins the API and UI, enforces repo scope and requires fresh joint evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-cross-repo-"));
  const projects = ["api", "ui", "other"].map((id) => ({ id, path: join(root, id) }));
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
    writeFileSync(join(project.path, "index.mjs"), "export default null;\n");
    git(project.path, "add", "index.mjs");
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
