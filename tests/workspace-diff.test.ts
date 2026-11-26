import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { diffLimits, diffSource, parseNameStatus, parseNumstat, parsePatch, taskDiff } from "../src/workspace-diff.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(t: TestContext, files: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-diff-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "repo");
  mkdirSync(path);
  try {
    git(path, "init", "-q");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("This execution sandbox blocks spawning Git from Node (EPERM).");
    return;
  }
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), contents);
  }
  git(path, "add", "-A");
  git(path, "commit", "-qm", "Baseline");
  return { root, path, base: git(path, "rev-parse", "HEAD") };
}

function objectCount(path: string) {
  const objects = join(path, ".git", "objects");
  return readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))
    .reduce((count, name) => count + readdirSync(join(objects, name)).length, 0);
}

test("parsers read name-status, numstat and patch output", () => {
  assert.deepEqual(parseNameStatus("M\0a.txt\0R087\0old name.txt\0new name.txt\0A\0dir/b.bin\0"), [
    { status: "M", path: "a.txt" },
    { status: "R", oldPath: "old name.txt", path: "new name.txt" },
    { status: "A", path: "dir/b.bin" },
  ]);
  assert.deepEqual(parseNumstat("3\t1\ta.txt\x000\t0\t\0old name.txt\0new name.txt\0-\t-\tdir/b.bin\0"), [
    { additions: 3, deletions: 1, binary: false, path: "a.txt" },
    { additions: 0, deletions: 0, binary: false, oldPath: "old name.txt", path: "new name.txt" },
    { additions: 0, deletions: 0, binary: true, path: "dir/b.bin" },
  ]);
  const [file, binary] = parsePatch([
    "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt",
    "@@ -2,3 +2,3 @@ heading", " same", "---removed", "+++added", "\\ No newline at end of file",
    "diff --git a/b.bin b/b.bin", "Binary files a/b.bin and b/b.bin differ", "",
  ].join("\n"));
  assert.deepEqual(file.lines, [
    ["@", "@@ -2,3 +2,3 @@ heading"], [" ", "same", 2, 2], ["-", "--removed", 3], ["+", "++added", null, 3],
    ["\\", " No newline at end of file"],
  ]);
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.lines, []);
});

test("an isolated worktree diff includes commits, uncommitted and untracked files without touching Git state", async (t) => {
  const fixture = repository(t, {
    "src/app.ts": Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join("\n") + "\n",
    "remove-me.txt": "bye\n",
    "rename-me.txt": "a stable file with enough content to be detected as a rename\n".repeat(4),
    ".gitignore": "ignored.log\n",
  });
  if (!fixture) return;
  const worktree = join(fixture.root, "candidate");
  git(fixture.path, "worktree", "add", "-q", "--detach", worktree, fixture.base);
  writeFileSync(join(worktree, "committed.txt"), "from a commit\n");
  git(worktree, "add", "committed.txt");
  git(worktree, "commit", "-qm", "Agent commit");
  const lines = readFileSync(join(worktree, "src/app.ts"), "utf8").split("\n");
  lines[5] = "line six changed";
  writeFileSync(join(worktree, "src/app.ts"), lines.join("\n"));
  rmSync(join(worktree, "remove-me.txt"));
  git(worktree, "mv", "rename-me.txt", "renamed file ✓.txt");
  writeFileSync(join(worktree, "new untracked.md"), "# Hello\n\nworld\n");
  writeFileSync(join(worktree, "ignored.log"), "noise\n");
  writeFileSync(join(worktree, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 10]));
  const status = git(worktree, "status", "--porcelain=v1", "-z");
  const objects = objectCount(fixture.path);
  const index = statSync(join(fixture.path, ".git", "worktrees", "candidate", "index")).mtimeMs;

  const group = await diffSource({ projectId: "app", mode: "automatic", path: worktree, base: fixture.base });
  assert.equal(group.error, undefined);
  const byPath = new Map(group.files.map((file) => [file.path, file]));
  assert.deepEqual([...byPath.keys()].sort(), ["committed.txt", "image.bin", "new untracked.md", "remove-me.txt",
    "renamed file ✓.txt", "src/app.ts"]);
  assert.equal(byPath.get("committed.txt")?.status, "A");
  assert.equal(byPath.get("remove-me.txt")?.status, "D");
  assert.equal(byPath.get("remove-me.txt")?.deletions, 1);
  assert.equal(byPath.get("renamed file ✓.txt")?.status, "R");
  assert.equal(byPath.get("renamed file ✓.txt")?.oldPath, "rename-me.txt");
  assert.deepEqual(byPath.get("new untracked.md"), {
    path: "new untracked.md", status: "A", additions: 3, deletions: 0, binary: false,
    lines: [["@", "@@ -0,0 +1,3 @@"], ["+", "# Hello", null, 1], ["+", "", null, 2], ["+", "world", null, 3]],
  });
  const binary = byPath.get("image.bin")!;
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.lines, []);
  const app = byPath.get("src/app.ts")!;
  assert.equal(app.status, "M");
  assert.equal(app.additions, 1);
  assert.equal(app.deletions, 1);
  assert.deepEqual(app.lines.filter(([kind]) => kind === "-" || kind === "+"),
    [["-", "line 6", 6], ["+", "line six changed", null, 6]]);
  assert.deepEqual(app.lines.find(([kind]) => kind === " "), [" ", "line 3", 3, 3]);

  // The diff stages into a throwaway index and object directory.
  assert.equal(statSync(join(fixture.path, ".git", "worktrees", "candidate", "index")).mtimeMs, index);
  assert.equal(objectCount(fixture.path), objects);
  assert.equal(git(worktree, "status", "--porcelain=v1", "-z"), status);
});

test("a configured checkout diff shows edits in place against the recorded base", async (t) => {
  const fixture = repository(t, { "README.md": "one\n" });
  if (!fixture) return;
  writeFileSync(join(fixture.path, "README.md"), "one\ntwo\n");
  git(fixture.path, "commit", "-qam", "User commit after approval");
  writeFileSync(join(fixture.path, "notes.txt"), "draft\n");
  const group = await diffSource({ projectId: "docs", mode: "checkout", path: fixture.path, base: fixture.base });
  assert.deepEqual(group.files.map(({ path, status, additions, deletions }) => [path, status, additions, deletions]),
    [["README.md", "M", 1, 0], ["notes.txt", "A", 1, 0]]);
  assert.equal(group.mode, "checkout");
  assert.equal(git(fixture.path, "status", "--porcelain"), "?? notes.txt");
});

test("large diffs are truncated per file and omitted past the byte limit", async (t) => {
  const fixture = repository(t, { "keep.txt": "keep\n" });
  if (!fixture) return;
  writeFileSync(join(fixture.path, "a-long.txt"), Array.from({ length: 3000 }, (_, i) => `row ${i}`).join("\n") + "\n");
  writeFileSync(join(fixture.path, "b-small.txt"), "small\n");
  const long = await diffSource({ projectId: "app", mode: "checkout", path: fixture.path, base: fixture.base });
  const [first, second] = long.files;
  assert.equal(first.path, "a-long.txt");
  assert.equal(first.additions, 3000);
  assert.equal(first.truncated, true);
  assert.equal(first.lines.length, diffLimits.fileLines);
  assert.equal(second.truncated, undefined);
  assert.equal(second.lines.length, 2);

  const previous = diffLimits.patchBytes;
  diffLimits.patchBytes = 2048;
  t.after(() => { diffLimits.patchBytes = previous; });
  const cut = await diffSource({ projectId: "app", mode: "checkout", path: fixture.path, base: fixture.base });
  assert.equal(cut.files[0].truncated, true);
  assert.ok(cut.files[0].lines.length < 300);
  assert.equal(cut.files[1].omitted, true);
  assert.equal(cut.files[1].additions, 1);
});

test("an unchanged source reports no files and unavailable sources report errors", async (t) => {
  const fixture = repository(t, { "a.txt": "a\n" });
  if (!fixture) return;
  assert.deepEqual(await diffSource({ projectId: "app", mode: "automatic", path: fixture.path, base: fixture.base }),
    { projectId: "app", mode: "automatic", base: fixture.base, files: [] });
  const missing = await diffSource({ projectId: "app", mode: "automatic", path: join(fixture.root, "gone"), base: fixture.base });
  assert.match(missing.error ?? "", /no longer exists/);
  const invalid = await diffSource({ projectId: "app", mode: "automatic", path: fixture.path, base: "--output=/tmp/x" });
  assert.match(invalid.error ?? "", /invalid/);
  const unknown = await diffSource({ projectId: "app", mode: "automatic", path: fixture.path, base: "a".repeat(40) });
  assert.match(unknown.error ?? "", /no longer available/);
  mkdirSync(join(fixture.path, "sub"));
  const nested = await diffSource({ projectId: "app", mode: "automatic", path: join(fixture.path, "sub"), base: fixture.base });
  assert.match(nested.error ?? "", /complete Git worktree/);
  assert.deepEqual(await taskDiff("general"), { kind: "general" });
});

test("the runtime reports a task's worktree and checkout edits as diff sources", async (t) => {
  const api = repository(t, { "index.mjs": "export default null;\n" });
  const ui = repository(t, { "index.mjs": "export default null;\n" });
  if (!api || !ui) return;
  const projects = [{ id: "api", path: api.path }, { id: "ui", path: ui.path }];
  const runtime = new WorkspaceRuntime({ cwd: api.path, projects });
  const internal = runtime as any;
  const cleanup = async () => {
    await runtime.close();
    for (const line of git(ui.path, "worktree", "list", "--porcelain").split("\n")) {
      const path = line.startsWith("worktree ") ? line.slice(9) : undefined;
      if (path && path !== ui.path) {
        git(ui.path, "worktree", "remove", "--force", path);
        rmSync(join(path, ".."), { recursive: true, force: true });
      }
    }
  };
  try {
  internal.setProvider("ready");
  let sequence = 0;
  const replies = new Map<string, any>();
  internal.server = {
    call: async (method: string) => {
      if (method === "thread/start") return { thread: { id: `thread-${++sequence}` }, modelProvider: "openai" };
      if (method === "turn/start") return { turn: { id: `turn-${++sequence}`, status: "inProgress" } };
      throw new Error(`Unexpected fixture RPC ${method}`);
    },
    reply: (id: string, value: any) => replies.set(id, value),
    close: async () => {},
  };

  const general = await runtime.command({ type: "createTask", name: "Chat", projectIds: [] }) as string;
  assert.equal(runtime.diffSources(general), "general");
  assert.equal(runtime.diffSources("missing"), undefined);

  const agentId = await runtime.command({ type: "createTask", name: "Edit", projectIds: ["api", "ui"] }) as string;
  assert.deepEqual(runtime.diffSources(agentId), []);
  const task = internal.sessions.get(agentId);
  await runtime.command({ type: "send", agentId, text: "Plan the edit." });
  await internal.onRequest({ id: "request", method: "item/tool/call", params: {
    threadId: task.threadId, turnId: task.run.turn.id, tool: "request_implementation",
    arguments: { summary: "Edit both.", targets: [{ projectId: "api", mode: "checkout" }] },
  } });
  const reply = replies.get("request");
  assert.equal(reply.success, true, reply.contentItems[0].text);
  internal.onEvent({ method: "turn/completed", params: {
    threadId: task.threadId, turn: { id: task.run.turn.id, status: "completed" },
  } });
  await runtime.command({ type: "approveImplementation", agentId, requestId: JSON.parse(reply.contentItems[0].text).requestId });

  const sources = runtime.diffSources(agentId);
  assert.ok(Array.isArray(sources));
  assert.deepEqual(sources.map(({ projectId, mode, base }) => [projectId, mode, base]),
    [["api", "checkout", api.base], ["ui", "automatic", ui.base]]);
  assert.equal(sources[0].path, api.path);
  assert.deepEqual(runtime.snapshot().agents.find(({ id }) => id === agentId)?.checkoutEdits, [{ projectId: "api", base: api.base }]);

  writeFileSync(join(api.path, "index.mjs"), "export default 'api';\n");
  writeFileSync(join(sources[1].path, "index.mjs"), "export default 'ui';\n");
  const diff = await taskDiff(sources);
  assert.equal(diff.kind, "repositories");
  assert.deepEqual(diff.kind === "repositories" && diff.groups.map(({ projectId, files }) =>
    [projectId, files.map(({ path, additions, deletions }) => [path, additions, deletions])]),
  [["api", [["index.mjs", 1, 1]]], ["ui", [["index.mjs", 1, 1]]]]);
  } finally {
    await cleanup();
  }
});
