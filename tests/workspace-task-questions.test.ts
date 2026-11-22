import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceStore } from "../src/workspace-store.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex-task-questions.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the task question fixture.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("answering one persisted task question after restart continues only its owning task", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "orchestra-questions-"));
  const tracePath = join(project, "provider.jsonl");
  process.env.ORCHESTRA_TEST_TRACE = tracePath;
  const store = workspaceStore(project, join(project, "state"));
  const createRuntime = () => new WorkspaceRuntime({ cwd: project, store });
  let runtime = createRuntime();
  t.after(async () => {
    await runtime.close();
    delete process.env.ORCHESTRA_TEST_TRACE;
    rmSync(project, { recursive: true, force: true });
  });
  const start = async () => {
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  };
  const restart = async () => {
    await runtime.close();
    runtime = createRuntime();
    await start();
  };

  await start();
  const delegatedId = String(await runtime.command({ type: "createTask", name: "Release research", projectIds: [] }));
  const soloId = String(await runtime.command({ type: "createTask", name: "Solo draft", projectIds: [] }));
  const send = (agentId: string, text: string) => runtime.command({ type: "send", agentId, text });
  const task = (id: string) => runtime.snapshot().agents.find((agent) => agent.id === id);
  const child = () => runtime.snapshot().agents.find(({ nativeChild, parentId }) => nativeChild && parentId === delegatedId);
  const pendingInputs = () => runtime.snapshot().agents.flatMap(({ id: agentId, messages }) =>
    messages.filter(({ productQuestion }) => productQuestion?.status === "pending")
      .map(({ id, text }) => ({ id, agentId, text })));

  await Promise.all([
    send(delegatedId, "Inspect the release notes and ask which release to use."),
    send(soloId, "Draft a short heading."),
  ]);
  await waitFor(() => Boolean(child()?.messages.some(({ text }) => text.includes("ORBIT-42")) &&
    task(soloId)?.messages.some(({ text }) => text === "A solo release heading.")));
  await send(soloId, "Ask whether to publish the draft.");
  await waitFor(() => pendingInputs().length === 2 && runtime.snapshot().agents.every((agent) => !agent.canCancel));
  const pending = pendingInputs();
  const delegated = pending.find(({ agentId }) => agentId === delegatedId);
  const solo = pending.find(({ agentId }) => agentId === soloId);
  assert(delegated && solo);
  const childId = child()?.id;
  assert(childId);
  assert(task(delegatedId)?.messages.some(({ id }) => id === delegated.id));
  assert(task(soloId)?.messages.some(({ id }) => id === solo.id));

  await restart();
  assert.deepEqual(pendingInputs(), pending);
  assert.equal(child()?.id, childId);
  assert.equal(child()?.messages.filter(({ text }) => text.includes("ORBIT-42")).length, 1);
  const answer = "Use ORBIT-42 and keep the draft unpublished.";
  await assert.rejects(runtime.command({ type: "answerProductQuestion", agentId: soloId, questionId: delegated.id, text: answer }));
  const failedAnswer = "Fixture rejection: use the wrong release.";
  await runtime.command({ type: "answerProductQuestion", agentId: delegatedId, questionId: delegated.id, text: failedAnswer });
  await waitFor(() => Boolean(task(delegatedId)?.messages.some(({ text, state }) =>
    text === failedAnswer && state === "failed") && pendingInputs().some(({ id }) => id === delegated.id)));
  assert.deepEqual(pendingInputs(), pending);

  await runtime.command({ type: "answerProductQuestion", agentId: delegatedId, questionId: delegated.id, text: answer });
  await waitFor(() => Boolean(task(delegatedId)?.messages.some(({ role, text }) => role === "assistant" && text === "Received the answer.")));
  assert.deepEqual(pendingInputs(), [solo]);
  const answerMessage = task(delegatedId)?.messages.find(({ role, text }) => role === "user" && text === answer);
  assert(answerMessage);
  assert.equal(answerMessage.answersProductQuestionId, delegated.id);
  assert.deepEqual(task(delegatedId)?.messages.find(({ id }) => id === delegated.id)?.productQuestion,
    { status: "answered", answerMessageId: answerMessage.id });
  assert(!task(soloId)?.messages.some(({ text }) => text.includes(answer)));
  await assert.rejects(runtime.command({ type: "answerProductQuestion", agentId: delegatedId, questionId: delegated.id, text: answer }));
  assert.equal(child()?.id, childId);
  assert.equal(child()?.messages.filter(({ text }) => text.includes("ORBIT-42")).length, 1);

  await restart();
  assert.deepEqual(pendingInputs(), [solo]);
  const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const answered = trace.filter(({ method, params }) => method === "turn/start" && params.input?.[0]?.text.includes(answer));
  assert.equal(answered.length, 1);
  assert.match(answered[0].params.input[0].text, /Use ORBIT-42 for the release\?/);
  assert.equal(answered[0].params.threadId,
    trace.find(({ method, params }) => method === "turn/start" && params.input?.[0]?.text.startsWith("Inspect the release notes"))?.params.threadId);
});
