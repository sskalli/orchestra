import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceStore } from "../src/workspace-store.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex-task-questions.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

test("a task's model and effort choice applies from the next Codex turn and survives a restart", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "orchestra-model-choice-"));
  const tracePath = join(project, "trace.jsonl");
  const savedTrace = process.env.ORCHESTRA_TEST_TRACE;
  process.env.ORCHESTRA_TEST_TRACE = tracePath;
  const store = workspaceStore(project, join(project, "state"));
  let runtime = new WorkspaceRuntime({ cwd: project, store });
  t.after(async () => {
    await runtime.close();
    if (savedTrace === undefined) delete process.env.ORCHESTRA_TEST_TRACE;
    else process.env.ORCHESTRA_TEST_TRACE = savedTrace;
    rmSync(project, { recursive: true, force: true });
  });
  const trace = () => readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const turns = () => trace().filter(({ method }) => method === "turn/start").map(({ params }) => params);
  const agent = (id: string) => runtime.snapshot().agents.find((entry) => entry.id === id)!;
  const reply = async (id: string, count: number) => {
    const deadline = Date.now() + 5_000;
    while (agent(id).messages.filter(({ role }) => role === "assistant").length < count || agent(id).status === "working") {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the fixture reply.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  await runtime.start();
  assert.deepEqual(await runtime.listModels(), { models: [
    { id: "fixture-default", label: "Fixture default", efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
    { id: "fixture-mini", label: "Fixture mini", efforts: ["low"], defaultEffort: "low" },
  ] }, "pages are joined and hidden models left out");

  const taskId = String(await runtime.command({ type: "createTask", name: "Chosen", projectIds: [], model: "fixture-mini", effort: "low" }));
  assert.equal(trace().find(({ method }) => method === "thread/start").params.model, "fixture-mini");
  await runtime.command({ type: "send", agentId: taskId, text: "Draft a short heading." });
  await reply(taskId, 1);
  assert.equal(turns()[0].model, "fixture-mini");
  assert.equal(turns()[0].effort, "low");

  await runtime.command({ type: "setModel", agentId: taskId, model: "fixture-default", effort: "high" });
  assert.deepEqual(agent(taskId).modelSettings, { requestedModel: "fixture-default", requestedEffort: "high", source: "override" });
  await runtime.command({ type: "send", agentId: taskId, text: "Continue the task." });
  await reply(taskId, 2);
  assert.equal(turns()[1].model, "fixture-default");
  assert.equal(turns()[1].effort, "high");
  await runtime.close();

  runtime = new WorkspaceRuntime({ cwd: project, store });
  await runtime.start();
  assert.equal(agent(taskId).modelSettings?.requestedEffort, "high");
  assert.equal(trace().find(({ method }) => method === "thread/resume").params.model, "fixture-default");
  await runtime.command({ type: "setModel", agentId: taskId, effort: "low" });
  await runtime.command({ type: "send", agentId: taskId, text: "Continue the task." });
  await reply(taskId, 3);
  assert.equal(turns()[2].model, "fixture-default");
  assert.equal(turns()[2].effort, "low");

  await runtime.command({ type: "archive", agentId: taskId });
  await assert.rejects(runtime.command({ type: "setModel", agentId: taskId, model: "fixture-mini" }), /Restore/);
});
