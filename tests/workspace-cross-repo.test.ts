import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";
import { WorkspaceUsage } from "../src/workspace-usage.ts";

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
  return { root, projects, baseline, runtime, ...providerFixture(runtime) };
}

function providerFixture(runtime: WorkspaceRuntime) {
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
  const call = async (session: any, name: string, args: object = {}) => {
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
  return { internal, requests, call, complete };
}

test("a direct task without repositories starts in a single read-only thread", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, requests, call, complete } = fixture;
  const agentId = await runtime.command({ type: "createTask", name: "Dinner ideas", projectIds: [] });
  assert.equal(typeof agentId, "string");
  const task = internal.sessions.get(agentId);
  assert.deepEqual(task.agent.directTask.projectIds, []);
  assert.equal(task.agent.directTask.phase, "planning");
  await runtime.command({ type: "send", agentId, text: "Suggest a weeknight dinner." });
  const started = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(started.threadId, task.threadId);
  assert.equal(started.sandboxPolicy.type, "readOnly");
  assert.equal(started.approvalPolicy, "never");
  assert.equal((await call(task, "request_implementation", { summary: "Write a recipe." })).success, false);
  complete(task);
  await assert.rejects(runtime.command({ type: "approveImplementation", agentId, requestId: "missing" }));
  assert.equal(runtime.snapshot().agents.length, 1);
});

test("one direct task plans and delivers an isolated cross-repo change in the same Codex thread", async (t) => {
  const fixture = crossRepoFixture(t, {
    api: "export default 'ready';\n",
    ui: "export default (value) => value.toUpperCase();\n",
    other: "export default null;\n",
  });
  if (!fixture) return;
  const { runtime, internal, projects, baseline, requests, call, complete } = fixture;
  await assert.rejects(runtime.command({ type: "createTask", name: "Invalid", projectIds: ["missing"] }));
  const agentId = await runtime.command({ type: "createTask", name: "Status payload", projectIds: ["api", "ui"] });
  assert.equal(typeof agentId, "string");
  const task = internal.sessions.get(agentId);
  const getTask = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!;
  const initial = projects.map(({ path }) => git(path, "worktree", "list", "--porcelain"));
  await runtime.command({ type: "send", agentId,
    text: "Plan to return { message: 'ready' } from the API and render the same display in the UI. Leave edits until approval." });
  const planning = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(planning.threadId, task.threadId);
  assert.equal(planning.sandboxPolicy.type, "readOnly");
  assert.equal(planning.approvalPolicy, "never");
  assert.deepEqual(projects.map(({ path }) => git(path, "worktree", "list", "--porcelain")), initial);
  internal.onEvent({ method: "item/completed", params: {
    threadId: task.threadId, turnId: task.run.turn.id,
    item: { type: "agentMessage", id: "proposed-plan", text: "Update both exports, then run the shared assertion." },
  } });
  const request = await call(task, "request_implementation", { summary: "Update both exports, then run the shared assertion." });
  assert.equal(request.success, true, request.text);
  const { requestId } = JSON.parse(request.text);
  assert.deepEqual(projects.map(({ path }) => git(path, "worktree", "list", "--porcelain")), initial);
  await assert.rejects(runtime.command({ type: "approveImplementation", agentId, requestId }));
  complete(task);

  await runtime.command({ type: "approveImplementation", agentId, requestId });
  const implementation = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(implementation.threadId, planning.threadId);
  assert.equal(requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(requests.filter(({ method }) => method === "turn/start").length, 2);
  assert.equal(getTask().directTask.phase, "implementing");
  await assert.rejects(runtime.command({ type: "approveImplementation", agentId, requestId }));
  assert.equal(requests.filter(({ method }) => method === "turn/start").length, 2);
  assert.equal(implementation.sandboxPolicy.type, "workspaceWrite");
  assert.equal(implementation.sandboxPolicy.networkAccess, false);
  assert.equal(implementation.sandboxPolicy.writableRoots.length, 2);
  for (const { path } of projects) assert(!implementation.sandboxPolicy.writableRoots.includes(path));
  const [api, ui] = projects;
  const worktreeFor = (path: string) => implementation.sandboxPolicy.writableRoots.find((candidate: string) =>
    git(path, "worktree", "list", "--porcelain").split("\n").includes("worktree " + candidate));
  const apiPath = worktreeFor(api.path);
  const uiPath = worktreeFor(ui.path);
  assert(apiPath && uiPath && apiPath !== uiPath);
  const check = (apiWorktree: string, uiWorktree: string) => execFileSync(process.execPath, [
    "--input-type=module", "-e", `import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const [api, ui] = await Promise.all(process.argv.slice(1).map(path => import(pathToFileURL(path).href)));
      assert.equal(ui.default(api.default), "READY");`, join(apiWorktree, "index.mjs"), join(uiWorktree, "index.mjs"),
  ]);
  writeFileSync(join(apiPath, "index.mjs"), "export default { message: 'ready' };\n");
  writeFileSync(join(uiPath, "index.mjs"), "export default ({ message }) => message.toUpperCase();\n");
  writeFileSync(join(apiPath, "ignored-local.txt"), "generated local data\n");
  check(apiPath, uiPath);
  const verification = await call(task, "submit_check_result", { outcome: "passed", summary: "API payload renders READY through the UI." });
  assert.equal(verification.success, true, verification.text);
  complete(task);

  const delivery = getTask();
  assert.equal(delivery.directTask.phase, "ready-for-review");
  assert.equal(runtime.snapshot().agents.length, 1);
  const members = delivery.integration?.members;
  assert.deepEqual(members?.map(({ projectId }) => projectId).sort(), ["api", "ui"]);
  const pinnedApi = members!.find(({ projectId }) => projectId === "api")!;
  const pinnedUi = members!.find(({ projectId }) => projectId === "ui")!;
  assert.notEqual(pinnedApi.path, apiPath);
  assert.notEqual(pinnedUi.path, uiPath);
  assert(!existsSync(join(pinnedApi.path, "ignored-local.txt")));
  check(pinnedApi.path, pinnedUi.path);
  projects.forEach(({ path }, index) => {
    assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(git(path, "rev-parse", "HEAD"), baseline[index]);
  });

  await runtime.command({ type: "send", agentId, text: "Explain the check results without making changes." });
  const followUp = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(followUp.threadId, planning.threadId);
  assert.equal(followUp.sandboxPolicy.type, "readOnly");
  assert.equal(followUp.approvalPolicy, "never");
  assert.equal((await call(task, "submit_check_result", { outcome: "passed", summary: "Unexpected read-only check." })).success, false);
  complete(task);
  assert.equal(getTask().directTask.phase, "ready-for-review");
  assert.equal(getTask().integration?.id, delivery.integration?.id);
});

test("implementation approval is tied to a pending request in its own conversation", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, runtime, internal, projects, requests, call, complete } = fixture;
  const store = workspaceStore(root, join(root, "state"));
  internal.store = store;
  internal.storageReady = true;
  const [api, ui] = projects;
  const agentId = String(await runtime.command({ type: "createTask", name: "Fix status", projectIds: ["api"] }));
  const otherId = String(await runtime.command({ type: "createTask", name: "Discuss status", projectIds: ["ui"] }));
  const task = internal.sessions.get(agentId);
  const initial = projects.map(({ path }) => git(path, "worktree", "list", "--porcelain"));
  const lastTurn = () => requests.findLast(({ method }) => method === "turn/start")?.params;
  const prompts = [
    "Implement now: Make no edits. I only want a review.",
    "Implement now: Fix the footer. Get my go-ahead before touching files.",
    "Go ahead and implement that.",
    "Please fix the status message in index.mjs.",
  ];
  for (const [index, text] of prompts.entries()) {
    await runtime.command({ type: "send", agentId, text });
    assert.equal(lastTurn().sandboxPolicy.type, "readOnly", text);
    if (index < prompts.length - 1) complete(task);
  }

  const summary = "Fix only the status message in index.mjs.";
  const request = await call(task, "request_implementation", { summary });
  assert.equal(request.success, true, request.text);
  const { requestId } = JSON.parse(request.text);
  complete(task);
  const getRequest = () => runtime.snapshot().agents.find(({ id }) => id === agentId)?.messages
    .find(({ id }) => id === requestId);
  const savedRequestStatus = () => store.load()?.find(({ agent }) => agent.id === agentId)?.agent.messages
    .find(({ id }) => id === requestId)?.implementationRequest?.status;
  assert.equal(getRequest()?.implementationRequest?.status, "pending");
  assert.equal(savedRequestStatus(), "pending");

  await assert.rejects(runtime.command({ type: "approveImplementation", agentId, requestId: "missing" }));
  await assert.rejects(runtime.command({ type: "approveImplementation", agentId: otherId, requestId }));
  assert.deepEqual(projects.map(({ path }) => git(path, "worktree", "list", "--porcelain")), initial);
  assert.equal(lastTurn().sandboxPolicy.type, "readOnly");
  await runtime.command({ type: "approveImplementation", agentId, requestId });

  const implementation = lastTurn();
  assert.equal(implementation.threadId, task.threadId);
  assert.equal(implementation.sandboxPolicy.type, "workspaceWrite");
  const [writableRoot] = implementation.sandboxPolicy.writableRoots;
  assert.equal(implementation.sandboxPolicy.writableRoots.length, 1);
  assert.notEqual(writableRoot, api.path);
  assert(git(api.path, "worktree", "list", "--porcelain").split("\n").includes("worktree " + writableRoot));
  assert.equal(git(ui.path, "worktree", "list", "--porcelain"), initial[1]);
  assert(implementation.input[0].text.includes(summary));
  assert.equal(getRequest()?.implementationRequest?.status, "approved");
  assert.equal(savedRequestStatus(), "approved");
  complete(task);

  await assert.rejects(runtime.command({ type: "approveImplementation", agentId, requestId }));
  assert.equal(lastTurn(), implementation);
});

test("command approvals are one-time decisions bound to the active implementation turn and checkout", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, projects, requests, call, complete } = fixture;
  const [api, other] = projects;
  const agentId = String(await runtime.command({ type: "createTask", name: "Verify API", projectIds: ["api"] }));
  const unrelatedId = String(await runtime.command({ type: "createTask", name: "Read the API", projectIds: ["api"] }));
  const task = internal.sessions.get(agentId);
  const replies = new Map<string, unknown[]>();
  const originalReply = internal.server.reply;
  internal.server.reply = (id: string, result: unknown) => {
    replies.set(id, [...(replies.get(id) ?? []), result]);
    originalReply(id, result);
  };
  const requestCommand = (id: string, cwd: string, details: Record<string, unknown> = {}) =>
    internal.onRequest({ id, method: "item/commandExecution/requestApproval", params: {
      threadId: task.threadId, turnId: task.run.turn.id, itemId: id,
      command: "npm test", cwd, reason: "Run the API verification.", ...details,
    } });
  const getApprovals = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!.messages.filter(({ commandApproval }) => commandApproval);
  const resolve = (requestId: string, decision: "approve" | "decline", requester = agentId) =>
    runtime.command({ type: "resolveCommandApproval", agentId: requester, requestId, decision });
  const declined = [{ decision: "decline" }];

  await runtime.command({ type: "send", agentId, text: "Plan the API update." });
  assert.equal(requests.findLast(({ method }) => method === "turn/start")?.params.approvalPolicy, "never");
  await requestCommand("read-only-command", api.path);
  assert.deepEqual(replies.get("read-only-command"), declined);
  assert.equal(getApprovals().length, 0);
  const implementation = await call(task, "request_implementation", {
    summary: "Update and verify the API.",
    targets: [{ projectId: "api", mode: "checkout" }],
  });
  assert.equal(implementation.success, true, implementation.text);
  const planningTurn = task.run.turn.id;
  complete(task);
  await runtime.command({ type: "approveImplementation", agentId, requestId: JSON.parse(implementation.text).requestId });
  assert.equal(requests.findLast(({ method }) => method === "turn/start")?.params.approvalPolicy, "on-request");

  await requestCommand("wrong-turn", api.path, { turnId: planningTurn });
  await requestCommand("wrong-project", other.path);
  const alias = join(api.path, "outside");
  symlinkSync(other.path, alias, "dir");
  await requestCommand("outside-through-symlink", alias);
  await requestCommand("stdin-approval", api.path, { kind: "writeStdin" });
  await requestCommand("additional-permissions", api.path, { additionalPermissions: { fileSystem: {}, network: null } });
  await requestCommand("network-approval", api.path, { networkApprovalContext: {} });
  await requestCommand("session-only", api.path, { availableDecisions: ["acceptForSession", "decline"] });
  await requestCommand("cancel-only-denial", api.path, { availableDecisions: ["accept", "cancel"] });
  assert.deepEqual(replies.get("cancel-only-denial"), [{ decision: "cancel" }]);
  await internal.onRequest({ id: "file-approval", method: "item/fileChange/requestApproval", params: {
    threadId: task.threadId, turnId: task.run.turn.id, itemId: "file-edit",
  } });
  for (const id of ["wrong-turn", "wrong-project", "outside-through-symlink", "stdin-approval",
    "additional-permissions", "network-approval", "session-only", "file-approval"]) {
    assert.deepEqual(replies.get(id), declined);
  }
  assert.equal(getApprovals().length, 0);

  await requestCommand("approve-this-command", api.path);
  await requestCommand("approve-this-command", api.path);
  assert.equal(getApprovals().length, 1);
  const approved = getApprovals().at(-1)!;
  assert(approved);
  assert.equal(approved.commandApproval?.status, "pending");
  assert.equal(approved.commandApproval?.command, "npm test");
  assert.equal(approved.commandApproval?.cwd, api.path);
  assert.equal(replies.has("approve-this-command"), false);
  await assert.rejects(resolve("not-a-request", "approve"));
  await assert.rejects(resolve(approved.id, "approve", unrelatedId));
  assert.equal(replies.has("approve-this-command"), false);
  task.run.check = { outcome: "passed" };
  await resolve(approved.id, "approve");
  assert.equal(task.run.check, undefined);
  assert.deepEqual(replies.get("approve-this-command"), [{ decision: "accept" }]);
  await assert.rejects(resolve(approved.id, "approve"));
  assert.deepEqual(replies.get("approve-this-command"), [{ decision: "accept" }]);

  await requestCommand("decline-this-command", api.path);
  await resolve(getApprovals().at(-1)!.id, "decline");
  assert.deepEqual(replies.get("decline-this-command"), declined);

  await requestCommand("withdrawn-by-provider", api.path);
  const withdrawn = getApprovals().at(-1)!;
  internal.onEvent({ method: "serverRequest/resolved", params: { threadId: task.threadId, requestId: "withdrawn-by-provider" } });
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "expired");
  await assert.rejects(resolve(withdrawn.id, "approve"));
  assert.equal(replies.has("withdrawn-by-provider"), false);

  await requestCommand("awaiting-at-turn-end", api.path);
  const pending = getApprovals().at(-1)!;
  assert.equal(pending.commandApproval?.status, "pending");
  const originalCall = internal.server.call;
  let acknowledgeStop!: () => void;
  internal.server.call = (method: string, params: unknown) => method === "turn/interrupt"
    ? new Promise<void>((resolve) => { acknowledgeStop = resolve; })
    : originalCall(method, params);
  const stopping = runtime.command({ type: "cancel", agentId });
  await assert.rejects(resolve(pending.id, "approve"), /stopping/);
  assert.equal(replies.has("awaiting-at-turn-end"), false);
  await requestCommand("arrived-during-stop", api.path);
  assert.deepEqual(replies.get("arrived-during-stop"), declined);
  acknowledgeStop();
  await stopping;
  complete(task);
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "expired");
  await assert.rejects(resolve(pending.id, "approve"));
  assert.equal(replies.has("awaiting-at-turn-end"), false);
});

test("mixed write approval uses the exact configured checkout and named linked worktree", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, runtime, internal, projects, baseline, requests, call, complete } = fixture;
  const [api, ui, other] = projects;
  const agentId = String(await runtime.command({ type: "createTask", name: "Mixed delivery", projectIds: ["api", "ui"] }));
  const task = internal.sessions.get(agentId);
  const lastTurn = () => requests.findLast(({ method }) => method === "turn/start")?.params;
  const getTask = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!;
  const worktree = join(root, "named-ui");
  const branch = "feature/approved-ui";
  const targets = [
    { projectId: "api", mode: "checkout" },
    { projectId: "ui", mode: "worktree", path: worktree, branch },
  ];
  const initial = projects.map(({ path }) => git(path, "worktree", "list", "--porcelain"));

  await runtime.command({ type: "send", agentId, text: "Use the existing API checkout and a named linked worktree for UI." });
  assert.equal(lastTurn().sandboxPolicy.type, "readOnly");
  const request = await call(task, "request_implementation", { summary: "Update both exports.", targets });
  assert.equal(request.success, true, request.text);
  const { requestId } = JSON.parse(request.text);
  const getRequest = () => getTask().messages.find(({ id }) => id === requestId)?.implementationRequest;
  assert.deepEqual(getRequest()?.targets, targets);
  assert.deepEqual(projects.map(({ path }) => git(path, "worktree", "list", "--porcelain")), initial);
  assert(!existsSync(worktree));
  complete(task);

  await runtime.command({ type: "approveImplementation", agentId, requestId });
  const implementation = lastTurn();
  assert.equal(implementation.threadId, task.threadId);
  assert.equal(implementation.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(implementation.sandboxPolicy.writableRoots, [api.path, worktree]);
  assert.equal(implementation.sandboxPolicy.excludeTmpdirEnvVar, true);
  assert.equal(implementation.sandboxPolicy.excludeSlashTmp, true);
  assert([api.path, worktree].includes(implementation.cwd));
  assert(implementation.input[0].text.includes(worktree));
  assert.equal(git(worktree, "branch", "--show-current"), branch);
  assert.equal(git(worktree, "rev-parse", "HEAD"), baseline[1]);
  assert.match(readFileSync(join(worktree, ".git"), "utf8"), /^gitdir: /);
  assert.equal(git(api.path, "worktree", "list", "--porcelain"), initial[0]);
  assert.equal(git(other.path, "worktree", "list", "--porcelain"), initial[2]);
  assert.equal(getRequest()?.status, "approved");

  writeFileSync(join(api.path, "index.mjs"), "export default 'updated API';\n");
  writeFileSync(join(worktree, "index.mjs"), "export default 'updated UI';\n");
  const verification = await call(task, "submit_check_result", { outcome: "passed", summary: "Both exports verified." });
  assert.equal(verification.success, true, verification.text);
  complete(task);

  const pinned = getTask().integration?.members ?? [];
  assert.deepEqual(pinned.map(({ projectId }) => projectId), ["ui"]);
  assert.equal(git(api.path, "worktree", "list", "--porcelain"), initial[0]);
  assert.equal(git(api.path, "rev-parse", "HEAD"), baseline[0]);
  assert.equal(git(api.path, "status", "--short"), "M index.mjs");
  assert.equal(git(ui.path, "status", "--short"), "");
  assert.equal(git(other.path, "status", "--short"), "");
  assert.equal(git(worktree, "branch", "--show-current"), branch);

  await runtime.command({ type: "send", agentId, text: "Explain the result without editing." });
  assert.equal(lastTurn().sandboxPolicy.type, "readOnly");
  complete(task);
});

test("write requests reject unsafe paths and repositories outside the selected scope", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, runtime, internal, projects, requests, call, complete } = fixture;
  const [api, ui] = projects;
  const agentId = String(await runtime.command({ type: "createTask", name: "Invalid destinations", projectIds: ["api", "ui"] }));
  const task = internal.sessions.get(agentId);
  const initial = projects.map(({ path }) => git(path, "worktree", "list", "--porcelain"));
  const alias = join(root, "ui-alias");
  symlinkSync(ui.path, alias, "dir");
  await runtime.command({ type: "send", agentId, text: "Investigate the exports." });

  const cases = [
    [{ projectId: "other", mode: "checkout" }],
    [{ projectId: "api", mode: "checkout", path: ui.path }],
    [{ projectId: "api", mode: "worktree", path: "./relative" }],
    [{ projectId: "api", mode: "worktree", path: join(ui.path, "nested") }],
    [{ projectId: "api", mode: "worktree", path: join(alias, "nested") }],
    [{ projectId: "api", mode: "worktree", path: join(api.path, ".git", "nested") }],
    [{ projectId: "api", mode: "worktree", path: join(root, "valid-path"), branch: "-unsafe" }],
  ];
  for (const targets of cases) {
    const reply = await call(task, "request_implementation", { summary: "Edit the export.", targets });
    assert.equal(reply.success, false, JSON.stringify(targets));
  }
  complete(task);
  assert(!runtime.snapshot().agents.find(({ id }) => id === agentId)?.messages.some(({ implementationRequest }) => implementationRequest));
  assert.deepEqual(projects.map(({ path }) => git(path, "worktree", "list", "--porcelain")), initial);
  assert.equal(requests.filter(({ method }) => method === "turn/start").length, 1);
});

test("older provider threads can request a checkout-only turn without creating a delivery snapshot", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, projects, requests, call, complete } = fixture;
  const [api] = projects;
  const agentId = String(await runtime.command({ type: "createTask", name: "Use current checkout", projectIds: ["api"] }));
  const task = internal.sessions.get(agentId);
  const initial = git(api.path, "worktree", "list", "--porcelain");
  const getTask = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!;
  await runtime.command({ type: "send", agentId, text: "Use the current checkout to update the export." });
  task.toolVersion = 15;
  const targets = [{ projectId: "api", mode: "checkout" }];
  const request = await call(task, "raise_product_decision", {
    question: "Request implementation targets: " + JSON.stringify({ summary: "Update the export.", targets }),
  });
  assert.equal(request.success, true, request.text);
  const { requestId } = JSON.parse(request.text);
  assert.deepEqual(getTask().messages.find(({ id }) => id === requestId)?.implementationRequest?.targets, targets);
  complete(task);

  await runtime.command({ type: "approveImplementation", agentId, requestId });
  const implementation = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.deepEqual(implementation.sandboxPolicy.writableRoots, [api.path]);
  assert.equal(implementation.cwd, api.path);
  writeFileSync(join(api.path, "index.mjs"), "export default 'updated';\n");
  const verification = await call(task, "submit_check_result", { outcome: "passed", summary: "Export verified." });
  assert.equal(verification.success, true, verification.text);
  complete(task);

  assert.equal(getTask().status, "done");
  assert.equal(getTask().directTask?.phase, "planning");
  assert.equal(getTask().integration, undefined);
  assert.equal(git(api.path, "worktree", "list", "--porcelain"), initial);
  assert.equal(git(api.path, "status", "--short"), "M index.mjs");
});

test("a recovered active writer reserves its checkout until Codex confirms completion", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, runtime, internal, projects, call, complete } = fixture;
  const [api] = projects;
  const store = workspaceStore(root, join(root, "state"));
  internal.store = store;
  internal.storageReady = true;
  const [writerId, waitingId] = await Promise.all(["First edit", "Second edit"].map(async (name) =>
    String(await runtime.command({ type: "createTask", name, projectIds: ["api"] }))));
  const prepare = async (agentId: string) => {
    const session = internal.sessions.get(agentId);
    await runtime.command({ type: "send", agentId, text: "Update the API in its configured checkout." });
    const result = await call(session, "request_implementation", {
      summary: "Update API export.",
      targets: [{ projectId: "api", mode: "checkout" }],
    });
    assert.equal(result.success, true, result.text);
    complete(session);
    return String(JSON.parse(result.text).requestId);
  };
  const firstRequest = await prepare(writerId);
  const secondRequest = await prepare(waitingId);
  await runtime.command({ type: "approveImplementation", agentId: writerId, requestId: firstRequest });

  const saved = store.load()!;
  const writer = saved.find(({ agent }) => agent.id === writerId)!;
  const waiting = saved.find(({ agent }) => agent.id === waitingId)!;
  assert(writer.run?.turnId);
  assert.equal(waiting.run, undefined);

  const reopened = new WorkspaceRuntime({ cwd: api.path, projects, store });
  t.after(() => reopened.close());
  const recovered = reopened as any;
  recovered.restore(saved);
  let writerStillActive = true;
  const newTurns: any[] = [];
  recovered.server = {
    call: async (method: string, params: any) => {
      if (method === "thread/resume") {
        const isWriter = params.threadId === writer.threadId;
        const active = isWriter && writerStillActive;
        return {
          modelProvider: "openai",
          thread: { id: params.threadId, status: { type: active ? "active" : "idle" } },
          initialTurnsPage: { data: isWriter ? [{ id: writer.run!.turnId, status: active ? "inProgress" : "completed" }] : [] },
        };
      }
      assert.equal(method, "turn/start");
      newTurns.push(params);
      return { turn: { id: "new-implementation-turn", status: "inProgress" } };
    },
    close: async () => {},
  };
  await recovered.resumeThread(writer);
  await recovered.resumeThread(waiting);
  recovered.setProvider("ready");
  assert.match(reopened.snapshot().agents.find(({ id }) => id === writerId)!.unavailableReason!, /active turn/i);

  const approval = { type: "approveImplementation", agentId: waitingId, requestId: secondRequest } as const;
  await assert.rejects(reopened.command(approval), /another task.*writing/i);
  assert.equal(newTurns.length, 0);
  assert.equal(reopened.snapshot().agents.find(({ id }) => id === waitingId)?.messages
    .find(({ id }) => id === secondRequest)?.implementationRequest?.status, "pending");

  writerStillActive = false;
  await recovered.resumeThread(writer);
  await reopened.command(approval);
  assert.equal(newTurns.length, 1);
  assert.equal(newTurns[0].threadId, waiting.threadId);
  assert.deepEqual(newTurns[0].sandboxPolicy.writableRoots, [api.path]);
});

test("separate runtimes cannot write the same Git checkout concurrently", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, runtime, internal, projects, call, complete } = fixture;
  const [api] = projects;
  internal.store = workspaceStore(root, join(root, "first-state"));
  internal.storageReady = true;
  const alias = { ...api, id: "api-alias" };
  const competing = new WorkspaceRuntime({
    cwd: api.path,
    projects: [alias],
    store: workspaceStore(root, join(root, "second-state")),
  });
  t.after(() => competing.close());
  const second = providerFixture(competing);
  second.internal.storageReady = true;

  const requestEdit = async (workspace: WorkspaceRuntime, provider: ReturnType<typeof providerFixture>, projectId: string) => {
    const agentId = String(await workspace.command({ type: "createTask", name: "Update API", projectIds: [projectId] }));
    const session = provider.internal.sessions.get(agentId);
    await workspace.command({ type: "send", agentId, text: "Edit this configured checkout." });
    const request = await provider.call(session, "request_implementation", {
      summary: "Update the API export.",
      targets: [{ projectId, mode: "checkout" }],
    });
    assert.equal(request.success, true, request.text);
    provider.complete(session);
    return { agentId, session, requestId: String(JSON.parse(request.text).requestId) };
  };

  const owner = await requestEdit(runtime, fixture, api.id);
  const waiter = await requestEdit(competing, second, alias.id);
  await runtime.command({ type: "approveImplementation", agentId: owner.agentId, requestId: owner.requestId });

  const approveSecond = () => competing.command({ type: "approveImplementation", agentId: waiter.agentId, requestId: waiter.requestId });
  await assert.rejects(approveSecond, /another task|already|reserved/i);
  assert.equal(second.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal(competing.snapshot().agents.find(({ id }) => id === waiter.agentId)?.messages
    .find(({ id }) => id === waiter.requestId)?.implementationRequest?.status, "pending");

  const verified = await call(owner.session, "submit_check_result", { outcome: "passed", summary: "Export verified." });
  assert.equal(verified.success, true, verified.text);
  complete(owner.session);
  await approveSecond();
  const secondTurn = second.requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.deepEqual(secondTurn.sandboxPolicy.writableRoots, [api.path]);
  second.complete(waiter.session);
});

test("restart supersedes a checkout request from a planning turn Codex interrupted", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, runtime, internal, projects, call } = fixture;
  const [api] = projects;
  const store = workspaceStore(root, join(root, "state"));
  internal.store = store;
  internal.storageReady = true;
  const agentId = String(await runtime.command({ type: "createTask", name: "Plan checkout edit", projectIds: ["api"] }));
  await runtime.command({ type: "send", agentId, text: "Investigate a change to the API checkout." });
  const result = await call(internal.sessions.get(agentId), "request_implementation", {
    summary: "Edit the API export.",
    targets: [{ projectId: "api", mode: "checkout" }],
  });
  assert.equal(result.success, true, result.text);
  const { requestId } = JSON.parse(result.text);
  const saved = store.load()!;
  assert(saved[0].run?.turnId);

  const reopened = new WorkspaceRuntime({ cwd: api.path, projects, store });
  t.after(() => reopened.close());
  const recovered = reopened as any;
  recovered.restore(saved);
  recovered.server = {
    call: async (method: string) => {
      assert.equal(method, "thread/resume");
      return {
        modelProvider: "openai",
        thread: { id: saved[0].threadId, status: { type: "idle" } },
        initialTurnsPage: { data: [{ id: saved[0].run!.turnId, status: "interrupted" }] },
      };
    },
    close: async () => {},
  };
  await recovered.resumeThread(saved[0]);
  recovered.setProvider("ready");
  const request = reopened.snapshot().agents.find(({ id }) => id === agentId)?.messages.find(({ id }) => id === requestId);
  assert.equal(request?.implementationRequest?.status, "superseded");
  await assert.rejects(reopened.command({ type: "approveImplementation", agentId, requestId }), /no longer pending/i);
});

test("an imperative answer resolves a product question in a read-only turn before implementation", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, projects, requests, call, complete } = fixture;
  const agentId = String(await runtime.command({ type: "createTask", name: "Footer", projectIds: ["ui"] }));
  const task = internal.sessions.get(agentId);
  const getQuestion = () => runtime.snapshot().agents.find(({ id }) => id === agentId)?.messages
    .find((message) => message.productQuestion);
  const worktrees = git(projects[1].path, "worktree", "list", "--porcelain");

  await runtime.command({ type: "send", agentId, text: "Review the footer." });
  const asked = await call(task, "raise_product_decision", { question: "Should we fix or remove the footer?" });
  assert.equal(asked.success, true, asked.text);
  const { questionId } = JSON.parse(asked.text);
  complete(task);

  const answer = "Fix this.";
  await runtime.command({ type: "send", agentId, text: answer });
  const answerTurn = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(answerTurn.sandboxPolicy.type, "readOnly");
  assert.equal(git(projects[1].path, "worktree", "list", "--porcelain"), worktrees);
  assert.equal(JSON.parse(answerTurn.additionalContext.orchestra_pending_questions.value).questions[0].id, questionId);
  const resolution = await call(task, "resolve_product_question", { questionId });
  assert.equal(resolution.success, true, resolution.text);
  const answerMessage = runtime.snapshot().agents.find(({ id }) => id === agentId)?.messages
    .find(({ role, text }) => role === "user" && text === answer);
  assert(answerMessage);
  assert.deepEqual(getQuestion()?.productQuestion, { status: "answered", answerMessageId: answerMessage.id });
  const request = await call(task, "request_implementation", { summary: "Fix the footer." });
  assert.equal(request.success, true, request.text);
  const { requestId } = JSON.parse(request.text);
  complete(task);

  await runtime.command({ type: "approveImplementation", agentId, requestId });
  const implementation = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(implementation.threadId, answerTurn.threadId);
  assert.equal(implementation.sandboxPolicy.type, "workspaceWrite");
});

test("direct tasks observe only their native children and recover their history without reopening them", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { root, projects, runtime, internal, requests, complete } = fixture;
  const store = workspaceStore(root, join(root, "state"));
  internal.store = store;
  internal.storageReady = true;
  internal.usage = new WorkspaceUsage(store.usagePath);
  const parentId = String(await runtime.command({ type: "createTask", name: "Release note", projectIds: [] }));
  const soloId = String(await runtime.command({ type: "createTask", name: "Solo draft", projectIds: [] }));
  const parent = internal.sessions.get(parentId);
  const solo = internal.sessions.get(soloId);
  await runtime.command({ type: "send", agentId: parentId, text: "Ask one child to check the release note." });
  await runtime.command({ type: "send", agentId: soloId, text: "Draft a release headline." });
  const threadStarts = requests.filter(({ method }) => method === "thread/start");
  assert.equal(threadStarts.length, 2);
  assert.equal(threadStarts[0].params.config["features.multi_agent_v2"], true);
  assert.deepEqual(requests.filter(({ method }) => method === "turn/start").map(({ params }) => params.threadId),
    [parent.threadId, solo.threadId]);
  const childThreadId = "provider-child-thread";
  const activity = (threadId: string, turnId: string, agentThreadId: string, kind: "started" | "completed") =>
    internal.onEvent({ method: "item/completed", params: { threadId, turnId, item: {
      type: "subAgentActivity", id: `${agentThreadId}-${kind}`, agentThreadId, agentPath: "/note-check",
      agentNickname: "Note check", kind,
    } } });
  const finishMessage = (threadId: string, turnId: string, id: string, text: string) =>
    internal.onEvent({ method: "item/completed", params: {
      threadId, turnId, item: { type: "agentMessage", id, text },
    } });
  finishMessage("unrelated-thread", "outside-turn", "outside-message", "Ignore unrelated provider data.");
  activity("unrelated-thread", "outside-turn", "foreign-child", "started");
  assert.equal(runtime.snapshot().agents.length, 2);

  activity(parent.threadId, parent.run.turn.id, childThreadId, "started");
  activity(parent.threadId, parent.run.turn.id, childThreadId, "started");
  const child = () => runtime.snapshot().agents.find(({ nativeChild }) => nativeChild);
  const observed = child();
  assert(observed);
  assert.equal(observed.parentId, parentId);
  assert.equal(observed.status, "working");
  assert.equal(runtime.snapshot().agents.filter(({ nativeChild }) => nativeChild).length, 1);
  await assert.rejects(runtime.command({ type: "send", agentId: observed.id, text: "Do work outside the parent." }));
  const childTurnId = "provider-child-turn";
  let approvalResult: unknown;
  const originalReply = internal.server.reply;
  internal.server.reply = (id: string, result: unknown) => {
    if (id === "child-file-approval") approvalResult = result;
    else originalReply(id, result);
  };
  await internal.onRequest({ id: "child-file-approval", method: "item/fileChange/requestApproval", params: {
    threadId: childThreadId, turnId: childTurnId, itemId: "child-patch",
  } });
  assert.deepEqual(approvalResult, { decision: "decline" });
  internal.onEvent({ method: "turn/started", params: {
    threadId: childThreadId, turn: { id: childTurnId, status: "inProgress" },
  } });
  finishMessage(childThreadId, childTurnId, "child-answer", "The release code is ORBIT-42.");
  const tokens = { totalTokens: 20, inputTokens: 18, cachedInputTokens: 4, outputTokens: 2,
    cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
  internal.onEvent({ method: "thread/tokenUsage/updated", params: {
    threadId: childThreadId, turnId: childTurnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 1000 },
  } });
  assert.deepEqual(runtime.snapshot().usage?.byAgent[observed.id]?.tokens, tokens);
  internal.onEvent({ method: "turn/completed", params: {
    threadId: childThreadId, turn: { id: childTurnId, status: "completed" },
  } });
  activity(parent.threadId, parent.run.turn.id, childThreadId, "completed");
  finishMessage(parent.threadId, parent.run.turn.id, "parent-answer", "Child verified ORBIT-42.");
  finishMessage(solo.threadId, solo.run.turn.id, "solo-answer", "A release headline.");
  complete(parent);
  complete(solo);
  assert.equal(child()?.status, "done");
  assert(child()?.messages.some(({ text }) => text.includes("ORBIT-42")));
  assert(runtime.snapshot().agents.find(({ id }) => id === parentId)?.messages.some(({ text }) =>
    text.includes("Child verified ORBIT-42.")));
  assert(runtime.snapshot().agents.find(({ id }) => id === soloId)?.messages.every(({ text }) => !text.includes("ORBIT-42")));

  const saved = store.load();
  assert(saved);
  assert.equal(saved.find(({ agent }) => agent.id === observed.id)?.threadId, childThreadId);
  const reopened = new WorkspaceRuntime({ cwd: projects[0].path, projects, store });
  t.after(() => reopened.close());
  const recovered = reopened as any;
  recovered.restore(saved);
  const childSession = recovered.sessions.get(observed.id);
  assert(childSession);
  const recoveryCalls: { method: string; params: any }[] = [];
  recovered.server = {
    call: async (method: string, params: any) => {
      recoveryCalls.push({ method, params });
      assert.equal(method, "thread/read");
      return { thread: {
        id: childThreadId, parentThreadId: parent.threadId, status: { type: "idle" },
        turns: [{ id: childTurnId, status: "completed", items: [
          { type: "agentMessage", id: "child-answer", text: "The release code is ORBIT-42." },
          { type: "agentMessage", id: "after-restart", text: "Recovered a later note." },
        ] }],
      } };
    },
    close: async () => {},
  };
  await recovered.resumeNativeChild(childSession);
  assert.deepEqual(recoveryCalls, [{ method: "thread/read", params: { threadId: childThreadId, includeTurns: true } }]);
  const restored = reopened.snapshot().agents.find(({ id }) => id === observed.id);
  assert.equal(restored?.parentId, parentId);
  assert.equal(restored?.messages.filter(({ text }) => text.includes("ORBIT-42")).length, 1);
  assert(restored?.messages.some(({ text }) => text === "Recovered a later note."));
});
