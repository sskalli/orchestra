import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
      if (method === "turn/steer") return {};
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
  await runtime.command({ type: "send", agentId, text: "Suggest a weeknight dinner." });
  const started = requests.findLast(({ method }) => method === "turn/start")?.params;
  assert.equal(started.threadId, task.threadId);
  assert.equal(started.sandboxPolicy.type, "readOnly");
  assert.equal(started.approvalPolicy, "on-request");
  assert.equal((await call(task, "request_implementation", { summary: "Write a recipe." })).success, false,
    "the removed implementation tool is refused for threads that still list it");
  complete(task);
  assert.equal(runtime.snapshot().agents.length, 1);
});

test("native Codex permission requests become one-time decisions in the task chat", async (t) => {
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
  // Codex offers accept, an optional rule amendment, and cancel for a sandbox escalation. It never offers decline.
  const escalation = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }, "cancel"];
  const requestCommand = (id: string, cwd: string, details: Record<string, unknown> = {}) =>
    internal.onRequest({ id, method: "item/commandExecution/requestApproval", params: {
      threadId: task.threadId, turnId: task.run.turn.id, itemId: id,
      command: "npm test", cwd, reason: "Run the API verification.", availableDecisions: escalation, ...details,
    } });
  const getApprovals = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!.messages.filter(({ commandApproval }) => commandApproval);
  const resolve = (requestId: string, decision: "approve" | "approveForSession" | "decline", requester = agentId) =>
    runtime.command({ type: "resolveCommandApproval", agentId: requester, requestId, decision });

  // Planning turns stay read-only but can ask for access, including outside the configured repositories.
  await runtime.command({ type: "send", agentId, text: "Update the notes file in the other folder." });
  // Commits the agent makes during the turn are reported in the chat as commands complete.
  git(api.path, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "--allow-empty", "-m", "Agent commit");
  internal.onEvent({ method: "item/completed", params: { threadId: task.threadId, turnId: task.run.turn.id,
    item: { id: "commit-1", type: "commandExecution", command: "git commit", status: "completed", exitCode: 0 } } });
  // Readings wait briefly so one covers a burst of commands, then run in the background.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await Promise.all([...internal.gitChecks]);
  const gitNotes = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!.messages.filter(({ kind }) => kind === "git");
  assert.equal(gitNotes().length, 1);
  assert.match(gitNotes()[0].text, /^Committed 1 commit on `[^`]+` in api: `[0-9a-f]{7}` Agent commit$/);
  assert.equal(requests.findLast(({ method }) => method === "turn/start")?.params.approvalPolicy, "on-request");
  assert.equal(requests.findLast(({ method }) => method === "turn/start")?.params.sandboxPolicy.type, "workspaceWrite");
  await requestCommand("planning-escalation", other.path, { command: "touch notes.md" });
  const planning = getApprovals().at(-1)!;
  assert.equal(planning.commandApproval?.status, "pending");
  assert.equal(planning.commandApproval?.cwd, other.path);
  assert.deepEqual(planning.commandApproval?.choices, ["approve", "decline"]);
  assert.equal(planning.commandApproval?.declineStopsTurn, true);
  assert.equal(replies.has("planning-escalation"), false);
  await assert.rejects(resolve(planning.id, "approveForSession"), /did not offer/);
  await resolve(planning.id, "approve");
  assert.deepEqual(replies.get("planning-escalation"), [{ decision: "accept" }]);
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "approved");

  internal.onEvent({ method: "item/started", params: { threadId: task.threadId, turnId: task.run.turn.id,
    item: { id: "patch-1", type: "fileChange", changes: [{ path: join(other.path, "notes.md"), kind: { type: "update" }, diff: "" }] } } });
  await internal.onRequest({ id: "file-approval", method: "item/fileChange/requestApproval", params: {
    threadId: task.threadId, turnId: task.run.turn.id, itemId: "patch-1", reason: "Edit the requested notes.",
  } });
  const fileApproval = getApprovals().at(-1)!;
  assert.equal(fileApproval.commandApproval?.kind, "fileChange");
  assert.deepEqual(fileApproval.commandApproval?.files, [join(other.path, "notes.md")]);
  assert.deepEqual(fileApproval.commandApproval?.choices, ["approve", "approveForSession", "decline"]);
  assert.deepEqual(fileApproval.commandApproval?.grantPaths, [other.path], "the card names the folder Allow for this task grants");
  await resolve(fileApproval.id, "approveForSession");
  assert.deepEqual(replies.get("file-approval"), [{ decision: "acceptForSession" }]);
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "approved-for-session");
  assert.deepEqual(task.agent.grantedPaths, [other.path], "allowing for the task grants the edited folder");
  assert.ok(internal.directTaskTurnScope(task).sandboxPolicy.writableRoots.includes(other.path), "later turns can write the folder");
  assert.deepEqual(internal.sessions.get(unrelatedId).agent.grantedPaths, undefined, "grants stay with their task");
  for (const [itemId, file] of [["home-file", join(homedir(), ".bashrc")], ["root-file", "/notes.md"]]) {
    internal.onEvent({ method: "item/started", params: { threadId: task.threadId, turnId: task.run.turn.id,
      item: { id: itemId, type: "fileChange", changes: [{ path: file, kind: { type: "update" }, diff: "" }] } } });
    await internal.onRequest({ id: itemId, method: "item/fileChange/requestApproval", params: {
      threadId: task.threadId, turnId: task.run.turn.id, itemId, reason: "Edit one file." } });
    const broad = getApprovals().at(-1)!;
    assert.equal(broad.commandApproval?.grantPaths, undefined, `a single file never grants ${dirname(file)}`);
    await resolve(broad.id, "approveForSession");
    assert.deepEqual(task.agent.grantedPaths, [other.path]);
  }

  const requested = { fileSystem: { write: [other.path], read: null }, network: null };
  await internal.onRequest({ id: "permission-request", method: "item/permissions/requestApproval", params: {
    threadId: task.threadId, turnId: task.run.turn.id, itemId: "permissions-1", cwd: api.path,
    reason: "Write to the requested folder.", permissions: requested,
  } });
  const permission = getApprovals().at(-1)!;
  assert.equal(permission.commandApproval?.kind, "permissions");
  assert.deepEqual(permission.commandApproval?.writePaths, [other.path]);
  await resolve(permission.id, "decline");
  assert.deepEqual(replies.get("permission-request"), [{ permissions: {}, scope: "turn" }]);
  await internal.onRequest({ id: "permission-granted", method: "item/permissions/requestApproval", params: {
    threadId: task.threadId, turnId: task.run.turn.id, itemId: "permissions-2", cwd: api.path, reason: null, permissions: requested,
  } });
  await resolve(getApprovals().at(-1)!.id, "approve");
  assert.deepEqual(replies.get("permission-granted"), [{ permissions: { fileSystem: requested.fileSystem }, scope: "turn" }]);
  const hidden = getApprovals().length;
  await internal.onRequest({ id: "permission-hidden", method: "item/permissions/requestApproval", params: {
    threadId: task.threadId, turnId: task.run.turn.id, itemId: "permissions-3", cwd: api.path, reason: null,
    permissions: { fileSystem: { write: [other.path, "/home/user/.ssh\u200b"] } },
  } });
  assert.deepEqual(replies.get("permission-hidden"), [{ permissions: {}, scope: "turn" }]);
  await internal.onRequest({ id: "blind-file-approval", method: "item/fileChange/requestApproval", params: {
    threadId: task.threadId, turnId: task.run.turn.id, itemId: "unknown-patch",
  } });
  assert.deepEqual(replies.get("blind-file-approval"), [{ decision: "decline" }]);
  assert.equal(getApprovals().length, hidden);

  const planningTurn = task.run.turn.id;
  complete(task);
  await runtime.command({ type: "send", agentId, text: "Verify the API." });
  assert.equal(requests.findLast(({ method }) => method === "turn/start")?.params.approvalPolicy, "on-request");

  const before = getApprovals().length;
  await requestCommand("wrong-turn", api.path, { turnId: planningTurn });
  await requestCommand("relative-cwd", "api");
  await requestCommand("hidden-text", api.path, { command: "npm test \u202e" });
  await requestCommand("stdin-approval", api.path, { kind: "writeStdin" });
  await requestCommand("no-approval-offered", api.path, { availableDecisions: ["decline"] });
  await requestCommand("hidden-extra-path", api.path, { availableDecisions: ["accept", "decline"],
    additionalPermissions: { fileSystem: { write: ["/tmp/x\u202e"] } } });
  assert.deepEqual(replies.get("hidden-extra-path"), [{ decision: "decline" }]);
  for (const id of ["wrong-turn", "relative-cwd", "hidden-text", "stdin-approval"]) {
    assert.deepEqual(replies.get(id), [{ decision: "cancel" }], id);
  }
  assert.deepEqual(replies.get("no-approval-offered"), [{ decision: "decline" }]);
  assert.equal(getApprovals().length, before);

  await requestCommand("additional-permissions", api.path, { availableDecisions: ["accept", "decline"],
    additionalPermissions: { fileSystem: { entries: [{ path: { type: "path", path: other.path }, access: "write" }] }, network: { enabled: true } } });
  const extra = getApprovals().at(-1)!;
  assert.deepEqual(extra.commandApproval?.writePaths, [other.path]);
  assert.equal(extra.commandApproval?.network, "Network access");
  assert.equal(extra.commandApproval?.declineStopsTurn, undefined);
  await resolve(extra.id, "decline");
  assert.deepEqual(replies.get("additional-permissions"), [{ decision: "decline" }]);
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "declined");

  await requestCommand("approve-this-command", api.path);
  await requestCommand("approve-this-command", api.path);
  const approved = getApprovals().at(-1)!;
  assert.equal(getApprovals().filter(({ id }) => id === approved.id).length, 1);
  assert.equal(approved.commandApproval?.status, "pending");
  assert.equal(approved.commandApproval?.command, "npm test");
  assert.equal(replies.has("approve-this-command"), false);
  await assert.rejects(resolve("not-a-request", "approve"));
  await assert.rejects(resolve(approved.id, "approve", unrelatedId));
  assert.equal(replies.has("approve-this-command"), false);
  await resolve(approved.id, "approve");
  assert.deepEqual(replies.get("approve-this-command"), [{ decision: "accept" }]);
  await assert.rejects(resolve(approved.id, "approve"));
  assert.deepEqual(replies.get("approve-this-command"), [{ decision: "accept" }]);

  await requestCommand("decline-this-command", api.path);
  await resolve(getApprovals().at(-1)!.id, "decline");
  assert.deepEqual(replies.get("decline-this-command"), [{ decision: "cancel" }]);

  await requestCommand("failed-decision-handoff", api.path);
  const unconfirmed = getApprovals().at(-1)!;
  const replying = internal.server.reply;
  let handoffAttempts = 0;
  internal.server.reply = (id: string, result: unknown) => {
    if (id !== "failed-decision-handoff") return replying(id, result);
    handoffAttempts++;
    throw new Error("App Server connection closed");
  };
  await assert.rejects(resolve(unconfirmed.id, "approve"), /could not confirm/);
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "unconfirmed");
  await assert.rejects(resolve(unconfirmed.id, "approve"), /no longer pending/);
  assert.equal(handoffAttempts, 1);
  internal.server.reply = replying;

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
  assert.deepEqual(replies.get("arrived-during-stop"), [{ decision: "cancel" }]);
  acknowledgeStop();
  await stopping;
  complete(task);
  assert.equal(getApprovals().at(-1)?.commandApproval?.status, "expired");
  await assert.rejects(resolve(pending.id, "approve"));
  assert.equal(replies.has("awaiting-at-turn-end"), false);
});

test("an imperative answer resolves a product question in a writable turn", async (t) => {
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
  assert.equal(answerTurn.sandboxPolicy.type, "workspaceWrite");
  assert.equal(git(projects[1].path, "worktree", "list", "--porcelain"), worktrees);
  assert.equal(JSON.parse(answerTurn.additionalContext.orchestra_pending_questions.value).questions[0].id, questionId);
  const resolution = await call(task, "resolve_product_question", { questionId });
  assert.equal(resolution.success, true, resolution.text);
  const answerMessage = runtime.snapshot().agents.find(({ id }) => id === agentId)?.messages
    .find(({ role, text }) => role === "user" && text === answer);
  assert(answerMessage);
  assert.deepEqual(getQuestion()?.productQuestion, { status: "answered", answerMessageId: answerMessage.id });
  complete(task);
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

test("tasks sharing a repository are warned, and Git changes no single task made are left out", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, projects, requests, complete } = fixture;
  const [api] = projects;
  const first = String(await runtime.command({ type: "createTask", name: "First", projectIds: ["api"] }));
  const second = String(await runtime.command({ type: "createTask", name: "Second", projectIds: ["api", "ui"] }));
  const agent = (id: string) => runtime.snapshot().agents.find((entry) => entry.id === id)!;
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await Promise.all([...internal.gitChecks]);
  };
  const commandDone = (id: string) => internal.onEvent({ method: "item/completed", params: {
    threadId: internal.sessions.get(id).threadId, turnId: internal.sessions.get(id).run.turn.id,
    item: { id: `command-${Math.random()}`, type: "commandExecution", status: "completed", exitCode: 0 } } });
  const commit = (cwd: string, text: string) =>
    git(cwd, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "--allow-empty", "-qm", text);

  await runtime.command({ type: "send", agentId: first, text: "Work on the API." });
  assert.equal(requests.findLast(({ method }) => method === "turn/start")?.params.additionalContext.orchestra_concurrent_tasks, undefined);
  await runtime.command({ type: "send", agentId: second, text: "Work on the API too." });
  const warning = agent(second).messages.findLast(({ kind }) => kind === "warning");
  assert.match(warning?.text ?? "", /^First is also working in api\./);
  const context = JSON.parse(requests.findLast(({ method }) => method === "turn/start")?.params.additionalContext.orchestra_concurrent_tasks.value);
  assert.match(context.instruction, /only in your own linked worktree/);
  assert.deepEqual(context.tasks, [{ name: "First", repositories: ["api"] }]);

  // While both run, a new worktree or a commit in the shared checkout could be either task's.
  const unclear = join(api.path, ".worktrees", "unclear");
  git(api.path, "worktree", "add", "-q", "-b", "unclear", unclear);
  commit(api.path, "Unclear commit");
  commandDone(first);
  commandDone(second);
  await settle();
  for (const id of [first, second]) {
    assert.equal(agent(id).taskWorktrees, undefined);
    assert.deepEqual(agent(id).messages.filter(({ kind }) => kind === "git"), []);
  }

  complete(internal.sessions.get(second));
  await settle();
  const own = join(api.path, ".worktrees", "first");
  git(api.path, "worktree", "add", "-q", "-b", "first-branch", own);
  commandDone(first);
  await settle();
  assert.deepEqual(agent(first).taskWorktrees?.map(({ path, branch }) => [path, branch]), [[own, "first-branch"]]);
  commit(own, "Own commit");
  commit(unclear, "Still unclear");
  commandDone(first);
  await settle();
  assert.deepEqual(agent(first).messages.filter(({ kind }) => kind === "git").map(({ text }) => text.replace(/`[0-9a-f]{7}`/, "`sha`")), [
    "Created branch `first-branch` in api at `sha` Unclear commit",
    "Committed 1 commit on `first-branch` in api: `sha` Own commit",
  ]);
  assert.deepEqual(agent(second).messages.filter(({ kind }) => kind === "git"), []);
  complete(internal.sessions.get(first));
});

test("a reply sent while the agent is working can resolve the question it answers", async (t) => {
  const fixture = crossRepoFixture(t);
  if (!fixture) return;
  const { runtime, internal, call, complete } = fixture;
  const agentId = String(await runtime.command({ type: "createTask", name: "Footer", projectIds: ["ui"] }));
  const task = internal.sessions.get(agentId);
  const question = () => runtime.snapshot().agents.find(({ id }) => id === agentId)!.messages.find(({ productQuestion }) => productQuestion)!;
  await runtime.command({ type: "send", agentId, text: "Review the footer." });
  const asked = await call(task, "raise_product_decision", { question: "Fix or remove the footer?" });
  const { questionId } = JSON.parse(asked.text);
  assert.equal((await call(task, "resolve_product_question", { questionId })).success, false,
    "a question cannot be resolved by the message that came before it");

  await runtime.command({ type: "steer", agentId, text: "Fix it." });
  const reply = runtime.snapshot().agents.find(({ id }) => id === agentId)!.messages.findLast(({ role }) => role === "user")!;
  assert.equal(reply.text, "Fix it.");
  const resolved = await call(task, "resolve_product_question", { questionId });
  assert.equal(resolved.success, true, resolved.text);
  assert.deepEqual(question().productQuestion, { status: "answered", answerMessageId: reply.id });
  assert.equal(runtime.snapshot().agents.find(({ id }) => id === agentId)!.messages.some(({ productQuestion }) => productQuestion?.status === "pending"), false);
  complete(task);
});
