import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
import { workspaceStore } from "../src/workspace-store.ts";
import { createFeatureWorktree } from "../src/workspace-worktree.ts";
import { parseWorkspaceArgs } from "../src/workspace-options.ts";
import { workspacePreferences } from "../src/workspace-preferences.ts";
import { resolveProjects, workspaceIdentity } from "../src/workspace-projects.ts";

test("workspace launch options select a Codex provider only in live mode", () => {
  assert.deepEqual(parseWorkspaceArgs([]), { live: false, projectPath: undefined, projects: [], provider: "openai" });
  assert.deepEqual(parseWorkspaceArgs(["--live", "/project", "--provider", "company-gateway"]), {
    live: true, projectPath: "/project", projects: [], provider: "company-gateway",
  });
  assert.throws(() => parseWorkspaceArgs(["--claude", "/project"]), /Unknown workspace option/);
  assert.deepEqual(parseWorkspaceArgs(["--project", "app=/app", "--project", "api=/api"]).projects, [
    { id: "app", path: "/app" }, { id: "api", path: "/api" },
  ]);
  assert.equal(parseWorkspaceArgs(["--project", "app=/app"]).live, true);
  assert.deepEqual(parseWorkspaceArgs(["--project", "app=/app", "--project", "api=/api", "--provider", "company"]).provider, "company");
  assert.throws(() => parseWorkspaceArgs(["--provider", "company-gateway"]), /Usage:/);
  assert.throws(() => parseWorkspaceArgs(["--live", "--provider"]), /provider ID/);
  assert.throws(() => parseWorkspaceArgs(["--project", "app=/app", "--project", "app=/other"]), /Duplicate project/);
  assert.throws(() => parseWorkspaceArgs(["--live", "/app", "--project", "api=/api"]), /either/);
  assert.throws(() => parseWorkspaceArgs(["--project", "missing-path"]), /ID and path/);
  const projects = [{ id: "app", path: "/app" }, { id: "api", path: "/api" }];
  assert.equal(workspaceIdentity(projects), workspaceIdentity([...projects].reverse()));
  assert.notEqual(workspaceIdentity(projects), workspaceIdentity(projects.slice(0, 1)));
});

test("browser drafts stay with their mode and Codex model provider", () => {
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
    state.set("orchestra:workspace:v1:codex:/example/project:view", JSON.stringify({
      drafts: { task: "Default draft" },
    }));

    const company = workspacePreferences(project, "codex", "company-gateway");
    assert.deepEqual(company.readView().drafts, {});
    company.writeView({ leftOpen: true, selectedId: null, drafts: { task: "Company draft" } });

    const defaultProvider = workspacePreferences(project, "codex", "openai");
    assert.deepEqual(defaultProvider.readView().drafts, { task: "Default draft" });
    defaultProvider.writeView({ ...defaultProvider.readView(), drafts: { task: "Updated default draft" } });
    assert.deepEqual(workspacePreferences(project, "codex").readView().drafts, { task: "Updated default draft" });
    assert.deepEqual(workspacePreferences(project, "codex", "company-gateway").readView().drafts, { task: "Company draft" });
    assert.deepEqual(workspacePreferences(project, "codex", "another-gateway").readView().drafts, {});
    assert.deepEqual(workspacePreferences(project, "demo").readView().drafts, {});
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
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
    assert.throws(() => resolveProjects([{ id: "a", path: repository }, { id: "b", path: repository }]), /different Git repository/);
    const linkedCheckout = createFeatureWorktree(repository).path;
    candidate = linkedCheckout;
    assert.throws(() => resolveProjects([{ id: "a", path: repository }, { id: "b", path: linkedCheckout }]),
      /Projects 'a' and 'b' share one/);
    writeFileSync(join(candidate, "feature.txt"), "candidate only");
    assert.equal(git("-C", repository, "status", "--porcelain"), "");
    const store = workspaceStore(repository, join(directory, "state"));
    const runtime = new WorkspaceRuntime({ cwd: repository, demo: true });
    store.save(runtime.snapshot().agents.map((agent) => ({ agent })));
    assert.equal(store.load()?.[0].agent.id, runtime.snapshot().agents[0].id);
    assert.equal(workspaceStore(repository + "-other", join(directory, "state")).load(), undefined);
  } finally {
    if (candidate) {
      git("-C", repository, "worktree", "remove", "--force", candidate);
      rmSync(join(candidate, ".."), { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("starting the task-only store copies direct sessions and leaves the previous file intact", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-migration-"));
  try {
    const project = "/example/project";
    const previous = join(directory, createHash("sha256").update(project).digest("hex") + ".json");
    const [task, child] = new WorkspaceRuntime({ cwd: project, demo: true }).snapshot().agents;
    const old = JSON.stringify({ version: 1, project, sessions: [
      { agent: { id: "coordinator", name: "Old coordinator", messages: [] } },
      { agent: task }, { agent: child },
    ] });
    writeFileSync(previous, old);
    const store = workspaceStore(project, directory);
    assert.deepEqual(store.load()?.map(({ agent }) => agent.id), [task.id, child.id]);
    store.save([]);
    assert.deepEqual(store.load(), []);
    assert.equal(readFileSync(previous, "utf8"), old);
  } finally {
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
