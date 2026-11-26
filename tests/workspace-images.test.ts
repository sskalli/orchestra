import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadLocalImage, maxLocalImageBytes, resolveLocalImage } from "../src/workspace-images.ts";

const base = mkdtempSync(join(tmpdir(), "orchestra-images-"));
after(() => rmSync(base, { recursive: true, force: true }));
const repository = join(base, "repository");
const worktree = join(base, "worktree");
const outside = join(base, "outside");
for (const directory of [repository, join(repository, "docs"), worktree, outside]) mkdirSync(directory, { recursive: true });
writeFileSync(join(repository, "docs", "diagram.png"), "png");
writeFileSync(join(repository, "notes.md"), "# notes");
writeFileSync(join(repository, ".env.png.txt"), "SECRET=1");
writeFileSync(join(worktree, "screenshot.webp"), "webp");
writeFileSync(join(outside, "secret.png"), "secret");
writeFileSync(join(outside, "passwd"), "root:x");
symlinkSync(join(outside, "secret.png"), join(repository, "escape.png"));
symlinkSync(join(outside, "passwd"), join(repository, "disguised.png"));
symlinkSync(join(repository, "docs", "diagram.png"), join(worktree, "linked.png"));
mkdirSync(join(repository, "folder.png"));
const roots = [worktree, repository];

test("serves image files inside a configured root by absolute, relative and file URL references", async () => {
  assert.deepEqual(await resolveLocalImage(join(repository, "docs", "diagram.png"), roots),
    { path: join(repository, "docs", "diagram.png"), type: "image/png", size: 3 });
  assert.equal((await resolveLocalImage("docs/diagram.png", roots) as { path: string }).path, join(repository, "docs", "diagram.png"));
  assert.equal((await resolveLocalImage("./screenshot.webp", roots) as { type: string }).type, "image/webp");
  assert.equal((await resolveLocalImage(pathToFileURL(join(worktree, "screenshot.webp")).href, roots) as { path: string }).path,
    join(worktree, "screenshot.webp"));
  assert.equal((await resolveLocalImage("docs/../docs/diagram.png", roots) as { path: string }).path,
    join(repository, "docs", "diagram.png"));
});

test("relative references prefer the first root that holds the file", async () => {
  writeFileSync(join(worktree, "shared.png"), "worktree");
  writeFileSync(join(repository, "shared.png"), "repository");
  assert.equal((await resolveLocalImage("shared.png", roots) as { path: string }).path, join(worktree, "shared.png"));
  assert.equal((await resolveLocalImage("shared.png", [repository, worktree]) as { path: string }).path, join(repository, "shared.png"));
});

test("refuses traversal and absolute paths outside the configured roots", async () => {
  assert.equal((await resolveLocalImage("../outside/secret.png", roots)).status, 403);
  assert.equal((await resolveLocalImage("docs/../../outside/secret.png", roots)).status, 403);
  assert.equal((await resolveLocalImage(join(outside, "secret.png"), roots)).status, 403);
  assert.equal((await resolveLocalImage(`${repository}/../outside/secret.png`, roots)).status, 403);
  assert.equal((await resolveLocalImage(pathToFileURL(join(outside, "secret.png")).href, roots)).status, 403);
  assert.equal((await resolveLocalImage(`${repository}-sibling/secret.png`, roots)).status, 403);
});

test("refuses symlinks that leave the roots or point at non-images", async () => {
  assert.equal((await resolveLocalImage("escape.png", [repository])).status, 403);
  assert.equal((await resolveLocalImage("disguised.png", [repository])).status, 403);
  assert.equal((await resolveLocalImage(join(repository, "escape.png"), roots)).status, 403);
  // A link between two allowed roots stays allowed.
  assert.equal((await resolveLocalImage("linked.png", roots) as { path: string }).path, join(repository, "docs", "diagram.png"));
});

test("refuses non-image files, directories, missing files, and oversized images", async () => {
  assert.equal((await resolveLocalImage("notes.md", roots)).status, 415);
  assert.equal((await resolveLocalImage(".env.png.txt", roots)).status, 415);
  assert.equal((await resolveLocalImage(join(repository, "notes.md"), roots)).status, 415);
  assert.equal((await resolveLocalImage("folder.png", roots)).status, 404);
  assert.equal((await resolveLocalImage("missing.png", roots)).status, 404);
  writeFileSync(join(repository, "huge.png"), "");
  truncateSync(join(repository, "huge.png"), maxLocalImageBytes + 1);
  assert.equal((await resolveLocalImage("huge.png", roots)).status, 413);
});

test("refuses malformed references, remote URLs, and empty root lists", async () => {
  assert.equal((await resolveLocalImage("", roots)).status, 400);
  assert.equal((await resolveLocalImage("docs/diagram.png\0.png", roots)).status, 400);
  assert.equal((await resolveLocalImage("https://example.com/image.png", roots)).status, 400);
  assert.equal((await resolveLocalImage("data:image/png;base64,AAAA.png", roots)).status, 400);
  assert.equal((await resolveLocalImage("file://remote-host/share/image.png", roots)).status, 400);
  assert.equal((await resolveLocalImage("docs/diagram.png", [])).status, 403);
  assert.equal((await resolveLocalImage("docs/diagram.png", ["relative/root"])).status, 403);
});

test("the runtime allows images from its configured repositories", async () => {
  const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");
  const runtime = new WorkspaceRuntime({ cwd: repository, demo: true });
  try {
    assert.equal(runtime.imageRoots()[0], repository);
    assert.deepEqual(runtime.imageRoots("unknown-agent"), runtime.imageRoots());
    // A task's own worktree comes before the repositories so relative references resolve there first.
    const task = runtime.snapshot().agents.find((agent) => agent.candidate);
    if (task) assert.equal(runtime.imageRoots(task.id)[0], task.candidate!.path);
    assert.equal((await resolveLocalImage("docs/diagram.png", runtime.imageRoots()) as { path: string }).path,
      join(repository, "docs", "diagram.png"));
  } finally {
    await runtime.close();
  }
});

test("loading reads the file through its handle and versions it by size and modification time", async () => {
  const path = join(repository, "versioned.png");
  writeFileSync(path, "first");
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  const first = await loadLocalImage("versioned.png", roots);
  assert.ok("body" in first);
  assert.equal(first.body.toString(), "first");
  assert.equal(first.type, "image/png");
  writeFileSync(path, "second");
  utimesSync(path, 1_700_000_100, 1_700_000_100);
  const second = await loadLocalImage("versioned.png", roots);
  assert.ok("body" in second);
  assert.equal(second.body.toString(), "second");
  assert.notEqual(second.etag, first.etag);
});

test("loading refuses what resolution refuses, and FIFOs without hanging", async () => {
  assert.equal((await loadLocalImage("../outside/secret.png", roots)).status, 403);
  assert.equal((await loadLocalImage("escape.png", [repository])).status, 403);
  assert.equal((await loadLocalImage("notes.md", roots)).status, 415);
  const fifo = join(repository, "pipe.png");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return;
  }
  assert.equal((await resolveLocalImage("pipe.png", roots)).status, 404);
  assert.equal((await loadLocalImage("pipe.png", roots)).status, 404);
});
