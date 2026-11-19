import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";
import { createFeatureWorktree } from "../src/workspace-worktree.ts";
import { numberAgentRoles } from "../src/workspace-agent-appearance.ts";
import { parseWorkspaceArgs } from "../src/workspace-options.ts";
import { workspacePreferences } from "../src/workspace-preferences.ts";

test("workspace launch options select a Codex provider only in live mode", () => {
  assert.deepEqual(parseWorkspaceArgs([]), { live: false, projectPath: undefined, provider: "openai", feature: false });
  assert.deepEqual(parseWorkspaceArgs(["--live", "/project", "--provider", "company-gateway"]), {
    live: true, projectPath: "/project", provider: "company-gateway", feature: false,
  });
  assert.throws(() => parseWorkspaceArgs(["--provider", "company-gateway"]), /Usage:/);
  assert.throws(() => parseWorkspaceArgs(["--live", "--provider"]), /provider ID/);
});

test("browser drafts stay with their Codex provider and preserve default legacy drafts", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const state = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => state.get(key) ?? null,
      setItem: (key: string, value: string) => state.set(key, value),
    },
  });
  try {
    const project = "/example/project";
    state.set("swarmer:workspace:v1:codex:/example/project:view", JSON.stringify({
      drafts: { coordinator: "Default draft" },
    }));

    const company = workspacePreferences(project, false, "company-gateway");
    assert.deepEqual(company.readView().drafts, {});
    company.writeView({ leftOpen: true, selectedId: null, drafts: { coordinator: "Company draft" } });

    const defaultProvider = workspacePreferences(project, false, "openai");
    assert.deepEqual(defaultProvider.readView().drafts, { coordinator: "Default draft" });
    defaultProvider.writeView({ ...defaultProvider.readView(), drafts: { coordinator: "Updated default draft" } });
    assert.deepEqual(workspacePreferences(project, false).readView().drafts, { coordinator: "Updated default draft" });
    assert.deepEqual(workspacePreferences(project, false, "company-gateway").readView().drafts, { coordinator: "Company draft" });
    assert.deepEqual(workspacePreferences(project, false, "another-gateway").readView().drafts, {});
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("simulation propagates designer failure and delivers all handoffs", async () => {
  const original = globalThis.setTimeout;
  const actions: (() => void)[] = [];
  globalThis.setTimeout = ((action: () => void, delay: number) => {
    assert(delay >= 1000 && delay <= 5000);
    actions.push(action);
    return 1;
  }) as typeof setTimeout;
  const runtime = new WorkspaceRuntime({ cwd: process.cwd(), demo: true });
  const signals: unknown[] = [];
  runtime.subscribeSignals((signal) => signals.push(signal));
  try {
    await runtime.start();
    await runtime.command({ type: "send", agentId: "coordinator", text: "/simulate team-messages" });
    while (actions.length) actions.shift()!();
    const { agents } = runtime.snapshot();
    const team = agents.filter((agent) => agent.simulation);
    assert.equal(team.length, 5);
    for (const duty of ["pm", "designer"]) assert.equal(team.find((agent) => agent.duty === duty)?.status, "error");
    assert.equal(team.find((agent) => agent.role === "lead")?.status, "error");
    assert.equal(agents[0].messages.at(-1)?.kind, "action");
    assert.equal(signals.length, 11);
  } finally {
    globalThis.setTimeout = original;
    await runtime.close();
  }
});

test("worktree changes stay isolated and saved state is project scoped", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-test-"));
  const repository = join(directory, "project");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  let candidate: string | undefined;
  try {
    git("init", "-q", repository);
    git("-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Baseline");
    candidate = createFeatureWorktree(repository).path;
    writeFileSync(join(candidate, "feature.txt"), "candidate only");
    assert.equal(git("-C", repository, "status", "--porcelain"), "");
    const store = workspaceStore(repository, join(directory, "state"));
    const runtime = new WorkspaceRuntime({ cwd: repository, demo: true });
    store.save(runtime.snapshot().agents.map((agent) => ({ agent })));
    assert.equal(store.load()?.[0].agent.id, "coordinator");
    assert.equal(workspaceStore(repository + "-other", join(directory, "state")).load(), undefined);
  } finally {
    if (candidate) {
      git("-C", repository, "worktree", "remove", "--force", candidate);
      rmSync(join(candidate, ".."), { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("role numbering restarts for each team including nested agents", () => {
  const agents = [
    { id: "a", name: "A", role: "lead" },
    { id: "pm", parentId: "a", name: "PM", role: "worker", duty: "pm" },
    { id: "r1", parentId: "pm", name: "Research", role: "worker", duty: "analyser" },
    { id: "b", name: "B", role: "lead" },
    { id: "r2", parentId: "b", name: "Research", role: "worker", duty: "analyser" },
  ];
  assert.deepEqual(numberAgentRoles(agents).map((agent) => agent.roleNumber), [1, 1, 1, 2, 1]);
});

test("legacy saved workspaces migrate on save and new state takes precedence", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-migration-"));
  const previousRoot = process.env.XDG_STATE_HOME;
  const previousNew = process.env.ORCHESTRA_STATE_DIR;
  const previousOld = process.env.SWARMER_STATE_DIR;
  process.env.XDG_STATE_HOME = directory;
  delete process.env.ORCHESTRA_STATE_DIR;
  delete process.env.SWARMER_STATE_DIR;
  try {
    const project = "/example/project";
    const agent = new WorkspaceRuntime({ cwd: project, demo: true }).snapshot().agents[0];
    const legacy = workspaceStore(project, join(directory, "swarmer"));
    legacy.save([{ agent }]);
    const current = workspaceStore(project);
    assert.equal(current.load()?.[0].agent.id, "coordinator");
    current.save([{ agent: { ...agent, name: "New pilot" } }]);
    assert.equal(current.load()?.[0].agent.name, "New pilot");
    assert.equal(legacy.load()?.[0].agent.name, agent.name);
    assert.equal(workspaceStore("/example/other").load(), undefined);
  } finally {
    for (const [key, value] of Object.entries({
      XDG_STATE_HOME: previousRoot, ORCHESTRA_STATE_DIR: previousNew, SWARMER_STATE_DIR: previousOld,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("custom providers use separate saved workspaces from the default provider", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-provider-state-"));
  try {
    const project = "/example/project";
    const defaultStore = workspaceStore(project, directory);
    const providerStore = workspaceStore(project, directory, "company-gateway");
    const agent = new WorkspaceRuntime({ cwd: project, demo: true }).snapshot().agents[0];
    defaultStore.save([{ agent }]);
    providerStore.save([{ agent: { ...agent, name: "Company provider" } }]);
    assert.equal(defaultStore.load()?.[0].agent.name, agent.name);
    assert.equal(providerStore.load()?.[0].agent.name, "Company provider");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
