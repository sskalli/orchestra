import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceStore, type SavedSession } from "../src/workspace-store.ts";
import { boundedTeamHandoff, type WorkspaceTeam } from "../src/workspace-teams.ts";

const project = "/fixture/team-project";
const sessions: SavedSession[] = [{
  agent: { id: "coordinator", name: "Coordinator", role: "coordinator", status: "idle", canSteer: false, messages: [], queueDepth: 0 },
}];
const team: WorkspaceTeam = {
  id: "stable-team-id",
  name: "Label reports",
  scope: "Maintain deterministic label reports.",
  projectIds: ["labels"],
  archivedAt: 1,
  handoff: { summary: "The parser normalizes labels.", paths: ["src/labels.ts"] },
};

test("team records and sessions round-trip together in the existing workspace file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-team-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, createHash("sha256").update(project).digest("hex") + ".json");
  writeFileSync(path, JSON.stringify({ version: 1, project, sessions }));
  const store = workspaceStore(project, directory);

  assert.deepEqual(store.loadWorkspace(), { sessions, teams: [] });
  store.save(sessions, [team]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, project, sessions, teams: [team] });
  assert.deepEqual(workspaceStore(project, directory).loadWorkspace(), { sessions, teams: [team] });
  assert.deepEqual(store.load(), sessions);

  store.save(sessions);
  assert.deepEqual(store.loadWorkspace()?.teams, [team]);
  store.save(sessions, []);
  assert.deepEqual(store.loadWorkspace()?.teams, []);
});

test("saved team records reject duplicate IDs and handoffs from foreign projects", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-team-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = workspaceStore(project, directory);
  const path = join(directory, createHash("sha256").update(project).digest("hex") + ".json");
  writeFileSync(path, JSON.stringify({ version: 1, project, sessions, teams: [team, team] }));
  assert.throws(() => store.loadWorkspace(), /saved team records/);

  const foreign = { ...team, handoff: { sourceRevisions: [{ projectId: "another", revision: "a".repeat(40) }] } };
  writeFileSync(path, JSON.stringify({ version: 1, project, sessions, teams: [foreign] }));
  assert.throws(() => store.loadWorkspace(), /saved team records/);
});

test("team handoff context is bounded and includes only unique repository paths and valid revisions", () => {
  const handoff = boundedTeamHandoff({
    summary: "a".repeat(2000),
    decisions: [" ", " keep", "keep ", ...Array.from({ length: 8 }, (_, index) => index + "x".repeat(300))],
    paths: ["/etc/passwd", "../external", "sub/../../external", "./file", "C:/temp/file", "src/main.ts", "src/main.ts",
      ...Array.from({ length: 15 }, (_, index) => "src/file" + index)],
    sourceRevisions: [
      { projectId: "labels", revision: "invalid" },
      { projectId: "labels", revision: "a".repeat(40) },
      { projectId: "labels", revision: "b".repeat(40) },
    ],
  });
  assert.equal(handoff.summary?.length, 1800);
  assert.equal(handoff.decisions?.[0], "keep");
  assert.equal(handoff.decisions?.length, 6);
  assert.equal(handoff.decisions?.[1].length, 240);
  assert.equal(handoff.paths?.length, 12);
  assert.equal(handoff.paths?.[0], "src/main.ts");
  assert.deepEqual(handoff.sourceRevisions, [{ projectId: "labels", revision: "b".repeat(40) }]);
});
