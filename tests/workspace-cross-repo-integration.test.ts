import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fingerprintCandidate, fingerprintIntegrationMembers, integrateProjectCandidates } from "../src/workspace-integration.ts";
import { createFeatureWorktree } from "../src/workspace-worktree.ts";

function git(path: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", path, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function projects(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-integration-fixture-"));
  const projects = ["api", "ui"].map((id) => ({ id, path: join(root, id) }));
  for (const { path } of projects) {
    mkdirSync(path);
    git(path, "init", "-q");
    git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Baseline");
  }
  t.after(() => {
    for (const { path } of projects) {
      for (const line of git(path, "worktree", "list", "--porcelain").split("\n").filter((entry) => entry.startsWith("worktree ")).slice(1)) {
        const candidate = line.slice("worktree ".length);
        git(path, "worktree", "remove", "--force", candidate);
        rmSync(dirname(candidate), { recursive: true, force: true });
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return projects;
}

function candidate(project: { id: string; path: string }, name: string) {
  const tree = createFeatureWorktree(project.path);
  writeFileSync(join(tree.path, name + ".txt"), name);
  return { ...tree, projectId: project.id, agentId: name, submissionId: name, expectedFingerprint: fingerprintCandidate(tree.path) };
}

test("cross-repo integration combines same-repo coders and pins a singleton without changing source checkouts", (t) => {
  const configured = projects(t);
  const [api, ui] = configured;
  const apiA = candidate(api, "api-a");
  const apiB = candidate(api, "api-b");
  const uiA = candidate(ui, "ui-a");
  const manifest = integrateProjectCandidates(configured, [apiA, uiA, apiB]);
  const [apiMember, uiMember] = manifest.members!;
  assert.notEqual(apiMember.path, apiA.path);
  assert.notEqual(apiMember.path, apiB.path);
  assert.equal(uiMember.path, uiA.path);
  assert.equal(manifest.fingerprint, fingerprintIntegrationMembers(manifest.members!.slice().reverse()));
  assert.equal(git(apiMember.path, "ls-files"), "api-a.txt\napi-b.txt");
  assert.deepEqual(manifest.sources.map(({ projectId }) => projectId), ["api", "api", "ui"]);
  assert.equal(git(api.path, "status", "--porcelain"), "");
  assert.equal(git(ui.path, "status", "--porcelain"), "");
  writeFileSync(join(uiA.path, "changed.txt"), "stale");
  assert.notEqual(manifest.fingerprint, fingerprintIntegrationMembers(manifest.members!));
});

test("a wrong-repo singleton rolls back an already combined group without removing its sources", (t) => {
  const configured = projects(t);
  const [api] = configured;
  const sources = [candidate(api, "api-a"), candidate(api, "api-b"), { ...candidate(api, "api-c"), projectId: "ui" }];
  const initial = git(api.path, "worktree", "list", "--porcelain");
  assert.throws(() => integrateProjectCandidates(configured, sources), /isolated worktree of this project/);
  assert.equal(git(api.path, "worktree", "list", "--porcelain"), initial);
  for (const source of sources) assert.equal(fingerprintCandidate(source.path), source.expectedFingerprint);
});
