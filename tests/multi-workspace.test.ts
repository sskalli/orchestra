import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceIdentity, resolveProjects } from "../src/workspace-projects.ts";
import { workspaceStore } from "../src/workspace-store.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workspace event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("shared workspace scopes delegation, worktrees, and resumed threads to their projects", async (t) => {
  const previousModel = process.env.CODEX_MODEL;
  process.env.CODEX_MODEL = "fixture-requested";
  t.after(() => {
    if (previousModel === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previousModel;
  });
  const directory = mkdtempSync(join(tmpdir(), "orchestra-multi-"));
  const trace = join(directory, "trace.jsonl");
  process.env.ORCHESTRA_TEST_TRACE = trace;
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const red = join(directory, "red");
  const blue = join(directory, "blue");
  for (const path of [red, blue]) {
    git("init", "-q", path);
    git("-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Baseline");
  }
  const projects = resolveProjects([{ id: "red", path: red }, { id: "blue", path: blue }]);
  const store = workspaceStore(workspaceIdentity(projects), join(directory, "state"));
  let runtime = new WorkspaceRuntime({ cwd: red, projects, modelProvider: "company", store });
  const candidates: { path: string; projectId: string }[] = [];
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready");
    const send = async (agentId: string, text: string) => {
      await runtime.command({ type: "send", agentId, text });
      await waitFor(() => runtime.snapshot().agents.find((agent) => agent.id === agentId)?.status !== "working");
    };
    await send("coordinator", "delegate::lead:missing-project");
    assert.equal(runtime.snapshot().agents.filter((agent) => agent.role === "lead").length, 0);
    await send("coordinator", "delegate:red:lead:red-task");
    await send("coordinator", "delegate:blue:lead:blue-task");
    for (const project of projects) {
      const lead = runtime.snapshot().agents.find((agent) => agent.role === "lead" && agent.projectId === project.id);
      assert(lead);
      await send(lead.id, "delegate::coder:make-code");
      const coder = runtime.snapshot().agents.find((agent) => agent.duty === "coder" && agent.projectId === project.id);
      assert(coder?.candidate);
      candidates.push({ path: coder.candidate.path, projectId: project.id });
      assert.equal(git("-C", coder.candidate.path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        git("-C", project.path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
      await waitFor(() => runtime.snapshot().agents.find((agent) => agent.id === coder.id)?.status === "awaiting-confirmation");
      const otherProject = project.id === "red" ? "blue" : "red";
      await send("coordinator", `delegate:${otherProject}:reviewer:wrong-project:${coder.id}`);
      assert.equal(runtime.snapshot().agents.some((agent) => agent.duty === "reviewer"), false);
      await send(lead.id, `delegate:${project.id === "red" ? "blue" : "red"}:analyser:wrong-project`);
      assert.equal(runtime.snapshot().agents.some((agent) => agent.name.endsWith("-analyser")), false);
    }
    await runtime.close();

    process.env.CODEX_MODEL = "fixture-restart-override";
    runtime = new WorkspaceRuntime({ cwd: blue, projects: [...projects].reverse(), modelProvider: "company", store });
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready");
    assert.equal(runtime.snapshot().agents.filter((agent) => agent.duty === "coder").length, 2);
    const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const starts = events.filter((event) => event.method === "thread/start");
    const resumed = events.filter((event) => event.method === "thread/resume");
    assert(starts.every((event) => event.params.modelProvider === "company"));
    assert(resumed.length > 0);
    assert(resumed.every((event) => event.params.modelProvider === "company" && event.params.model === "fixture-requested"));
    assert(runtime.snapshot().agents.every((agent) => agent.modelSettings?.reportedModel === "fixture-requested"));
    for (const project of projects) {
      assert(starts.some((event) => event.params.cwd === project.path && event.params.developerInstructions.includes(`assigned project is ${project.id}`)));
      const candidate = candidates.find((entry) => entry.projectId === project.id)!;
      assert(starts.some((event) => event.params.cwd === candidate.path &&
        event.params.developerInstructions.includes("Work on the candidate worktree")));
      assert(resumed.some((event) => event.params.cwd === candidate.path));
    }
    assert(events.some((event) => event.method === "tool/result" && event.result?.success === false &&
      event.result.contentItems[0].text.includes("Choose a projectId")));
  } finally {
    await runtime.close();
    for (const candidate of candidates) {
      const project = projects.find((entry) => entry.id === candidate.projectId)!;
      git("-C", project.path, "worktree", "remove", "--force", candidate.path);
      rmSync(join(candidate.path, ".."), { recursive: true, force: true });
    }
    delete process.env.ORCHESTRA_TEST_TRACE;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing single-project sessions without project IDs still resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-single-"));
  process.env.ORCHESTRA_TEST_TRACE = join(directory, "trace.jsonl");
  const store = workspaceStore(directory, join(directory, "state"));
  const demo = new WorkspaceRuntime({ cwd: directory, demo: true });
  const coordinator = demo.snapshot().agents.find((agent) => agent.role === "coordinator")!;
  const lead = demo.snapshot().agents.find((agent) => agent.role === "lead")!;
  store.save([
    { agent: coordinator, threadId: "old-coordinator", toolVersion: 7 },
    { agent: { ...lead, projectId: undefined, messages: [...lead.messages, { id: "submitted", role: "user", text: "Continue" }] },
      threadId: "old-lead", toolVersion: 7 },
  ]);
  const runtime = new WorkspaceRuntime({ cwd: directory, store });
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready");
    assert.equal(runtime.snapshot().agents.find((agent) => agent.id === lead.id)?.projectId, runtime.snapshot().projects[0].id);
    const events = readFileSync(process.env.ORCHESTRA_TEST_TRACE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert(events.some((event) => event.method === "account/read"));
    assert(events.some((event) => event.method === "thread/resume" && event.params.threadId === "old-lead"));
  } finally {
    await runtime.close();
    await demo.close();
    delete process.env.ORCHESTRA_TEST_TRACE;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a shared workspace can reopen after a live message simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-simulation-"));
  process.env.ORCHESTRA_TEST_TRACE = join(directory, "trace.jsonl");
  const projects = [{ id: "red", path: directory }, { id: "blue", path: tmpdir() }];
  const store = workspaceStore(workspaceIdentity(projects), join(directory, "state"));
  const options = { cwd: directory, projects, store };
  let runtime = new WorkspaceRuntime(options);
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready");
    await runtime.command({ type: "send", agentId: "coordinator", text: "/simulate team-messages" });
    const simulation = runtime.snapshot().agents.filter((agent) => agent.simulation);
    assert.equal(simulation.length, 5);
    await runtime.close();
    const saved = store.load();
    assert(saved);
    assert(saved.every(({ agent }) => !agent.simulation));

    // An older runtime saved simulated agents without assigning them to a project.
    store.save([...saved, ...simulation.map((agent) => ({ agent }))]);
    runtime = new WorkspaceRuntime(options);
    await runtime.start();
    assert.equal(runtime.snapshot().provider.state, "ready");
    assert(runtime.snapshot().agents.every((agent) => !agent.simulation));
  } finally {
    await runtime.close();
    delete process.env.ORCHESTRA_TEST_TRACE;
    rmSync(directory, { recursive: true, force: true });
  }
});
