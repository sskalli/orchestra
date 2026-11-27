import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeGitActivity, gitCommonDirectory, listWorktrees, readRefState, snapshotCheckout } from "../src/workspace-git-activity.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8",
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
const texts = (notes: { text: string }[]) => notes.map(({ text }) => text.replace(/`[0-9a-f]{7}`/, "`sha`")).sort();

function repositories(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-git-activity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const repository = join(root, "app");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", repository);
  writeFileSync(join(repository, "a.txt"), "a\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "Initial");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-qu", "origin", "main");
  return { root, remote, repository };
}

test("commits, new branches and pushes in a repository and its worktrees are reported", async (t) => {
  const { repository } = repositories(t);
  assert.equal(await gitCommonDirectory(repository), join(repository, ".git"));

  const before = (await readRefState(repository))!;
  const worktree = join(repository, ".worktrees", "feature");
  git(repository, "worktree", "add", "-q", "-b", "feature", worktree);
  assert.equal(await gitCommonDirectory(worktree), join(repository, ".git"), "a linked worktree shares the main Git directory");
  assert.deepEqual((await listWorktrees(repository))?.map(({ path, branch, main }) => [path, branch, main ?? false]),
    [[repository, "main", true], [worktree, "feature", false]]);
  writeFileSync(join(worktree, "b.txt"), "b\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-qm", "Add b");
  writeFileSync(join(repository, "a.txt"), "a2\n");
  git(repository, "commit", "-qam", "Update a");
  git(repository, "commit", "-q", "--allow-empty", "-m", "Second");
  const committed = (await readRefState(repository))!;
  assert.deepEqual(texts(await describeGitActivity(repository, "app", before, committed)), [
    "Committed 2 commits on `main` in app: `sha` Second",
    "Created branch `feature` in app at `sha` Add b",
  ]);
  assert.deepEqual(texts(await describeGitActivity(repository, "app", before, committed, (branch) => branch === "feature")),
    ["Created branch `feature` in app at `sha` Add b"], "branches that belong to another task are left out");

  git(worktree, "push", "-qu", "origin", "feature");
  git(repository, "push", "-q");
  assert.deepEqual(texts(await describeGitActivity(repository, "app", committed, (await readRefState(repository))!)), [
    "Published branch `feature` in app to origin at `sha`",
    "Pushed `main` in app to origin at `sha`",
  ]);
  const settled = (await readRefState(repository))!;
  assert.deepEqual(await describeGitActivity(repository, "app", settled, settled), []);
  assert.equal(await readRefState(join(repository, "missing")), undefined);
});

test("pulling, fetching and resetting are not reported as the task's commits or pushes", async (t) => {
  const { root, remote, repository } = repositories(t);
  const other = join(root, "other");
  git(root, "clone", "-q", remote, other);
  git(other, "commit", "-q", "--allow-empty", "-m", "From elsewhere");
  git(other, "push", "-q");

  const before = (await readRefState(repository))!;
  git(repository, "pull", "-q");
  assert.deepEqual(await describeGitActivity(repository, "app", before, (await readRefState(repository))!), []);

  git(other, "commit", "-q", "--allow-empty", "-m", "Fetched only");
  git(other, "push", "-q");
  const fetched = (await readRefState(repository))!;
  git(repository, "fetch", "-q");
  git(repository, "reset", "-q", "--hard", "origin/main");
  assert.deepEqual(await describeGitActivity(repository, "app", fetched, (await readRefState(repository))!), []);
});

test("a checkout snapshot keeps uncommitted edits out of the task's changes", async (t) => {
  const { repository } = repositories(t);
  const head = git(repository, "rev-parse", "HEAD");
  assert.equal(await snapshotCheckout(repository, "refs/orchestra/task-start/clean"), head, "a clean checkout records HEAD");
  assert.equal(git(repository, "for-each-ref", "refs/orchestra"), "", "no ref is kept for a clean checkout");

  writeFileSync(join(repository, "a.txt"), "edited before the task\n");
  const snapshot = (await snapshotCheckout(repository, "refs/orchestra/task-start/dirty"))!;
  assert.notEqual(snapshot, head);
  assert.equal(git(repository, "rev-parse", "refs/orchestra/task-start/dirty"), snapshot, "the snapshot is kept from garbage collection");
  assert.equal(git(repository, "show", `${snapshot}:a.txt`), "edited before the task");
  assert.equal(git(repository, "status", "--porcelain"), "M a.txt", "the checkout itself is untouched");
});
