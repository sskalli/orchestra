import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeGitActivity, gitCommonDirectory, readRefState } from "../src/workspace-git-activity.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8",
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();

test("commits, new branches and pushes in a repository and its worktrees are reported", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-git-activity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const repository = join(root, "app");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", repository);
  writeFileSync(join(repository, "a.txt"), "a\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "Initial");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-u", "origin", "main");
  assert.equal(gitCommonDirectory(repository), join(repository, ".git"));

  const before = readRefState(repository)!;
  const worktree = join(repository, ".worktrees", "feature");
  git(repository, "worktree", "add", "-b", "feature", worktree);
  assert.equal(gitCommonDirectory(worktree), join(repository, ".git"), "a linked worktree shares the main Git directory");
  writeFileSync(join(worktree, "b.txt"), "b\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "Add b");
  writeFileSync(join(repository, "a.txt"), "a2\n");
  git(repository, "commit", "-am", "Update a");
  const committed = readRefState(repository)!;
  const notes = describeGitActivity(repository, "app", before, committed);
  assert.equal(notes.length, 2);
  assert.match(notes.find((note) => note.includes("`feature`"))!, /^Created branch `feature` in app at `[0-9a-f]{7}` Add b$/);
  assert.match(notes.find((note) => note.includes("`main`"))!, /^Committed 1 commit on `main` in app: `[0-9a-f]{7}` Update a$/);

  git(worktree, "push", "-u", "origin", "feature");
  git(repository, "push");
  const pushed = describeGitActivity(repository, "app", committed, readRefState(repository)!);
  assert.deepEqual(pushed.map((note) => note.replace(/`[0-9a-f]{7}`/, "`sha`")).sort(), [
    "Published branch `feature` in app to origin at `sha`",
    "Pushed `main` in app to origin at `sha`",
  ]);
  assert.deepEqual(describeGitActivity(repository, "app", readRefState(repository)!, readRefState(repository)!), []);
  assert.equal(readRefState(join(root, "missing")), undefined);
});
