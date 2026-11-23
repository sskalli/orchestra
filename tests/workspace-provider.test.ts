import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceStore } from "../src/workspace-store.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex-task-questions.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

test("custom providers run and resume direct tasks with isolated state and credentials", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "orchestra-custom-provider-"));
  const tracePath = join(project, "trace.jsonl");
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    ORCHESTRA_TEST_TRACE: tracePath,
    OPENAI_API_KEY: "fixture-openai-key",
    CODEX_API_KEY: "fixture-codex-key",
    COMPANY_API_KEY: "fixture-company-key",
    CODEX_MODEL: "company-model",
  });
  const stateDir = join(project, "state");
  const customStore = workspaceStore(project, stateDir, "company");
  const defaultStore = workspaceStore(project, stateDir);
  const makeRuntime = () => new WorkspaceRuntime({ cwd: project, modelProvider: "company", store: customStore });
  let runtime = makeRuntime();
  t.after(async () => {
    await runtime.close();
    for (const key of ["ORCHESTRA_TEST_TRACE", "OPENAI_API_KEY", "CODEX_API_KEY", "COMPANY_API_KEY", "CODEX_MODEL"]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(project, { recursive: true, force: true });
  });
  const waitForReply = async (id: string, text: string) => {
    const deadline = Date.now() + 5_000;
    while (!runtime.snapshot().agents.find((agent) => agent.id === id)?.messages.some((entry) => entry.text === text)) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the custom provider reply.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert.equal(runtime.snapshot().modelProvider, "company");
  const taskId = String(await runtime.command({ type: "createTask", name: "Custom task", projectIds: [] }));
  await runtime.command({ type: "send", agentId: taskId, text: "Draft a short heading." });
  await waitForReply(taskId, "A solo release heading.");
  assert.equal(defaultStore.load(), undefined);
  await runtime.close();

  process.env.CODEX_MODEL = "different-model";
  runtime = makeRuntime();
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert.equal(runtime.snapshot().agents[0]?.id, taskId);
  await runtime.command({ type: "send", agentId: taskId, text: "Continue the task." });
  await waitForReply(taskId, "Received the answer.");

  const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(trace.filter(({ method }) => method === "environment").map(({ params }) => params), [
    { openaiKey: false, codexKey: false, customKey: true },
    { openaiKey: false, codexKey: false, customKey: true },
  ]);
  assert.equal(trace.filter(({ method }) => method === "account/read").length, 0);
  const start = trace.find(({ method }) => method === "thread/start");
  const resume = trace.find(({ method }) => method === "thread/resume");
  assert.equal(start.params.modelProvider, "company");
  assert.equal(start.params.model, "company-model");
  assert.equal(resume.params.modelProvider, "company");
  assert.equal(resume.params.model, "company-model");
  assert.equal(resume.params.threadId, trace.find(({ method }) => method === "turn/start").params.threadId);
  assert.equal(trace.filter(({ method }) => method === "turn/start").length, 2);
});
