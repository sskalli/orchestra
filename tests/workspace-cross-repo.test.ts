import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return { root, projects, baseline, runtime, internal, requests, call, complete };
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
