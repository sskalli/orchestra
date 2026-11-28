import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AttachmentTooLarge, attachmentLimits, readAttachmentBody, sanitizeAttachmentName, saveAttachment } from "../src/workspace-attachments.ts";
import { ClaudeAppServer } from "../src/claude-app-server.ts";

const base = mkdtempSync(join(tmpdir(), "orchestra-attachments-"));
after(() => rmSync(base, { recursive: true, force: true }));

test("dropped file names become one safe path segment", () => {
  assert.equal(sanitizeAttachmentName("report.pdf"), "report.pdf");
  assert.equal(sanitizeAttachmentName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachmentName("..\\..\\boot.ini"), "boot.ini");
  assert.equal(sanitizeAttachmentName(".."), "file");
  assert.equal(sanitizeAttachmentName(".env"), "env");
  assert.equal(sanitizeAttachmentName(""), "file");
  assert.equal(sanitizeAttachmentName("a\u0000b\nc‮.txt"), "abc.txt");
  assert.equal(sanitizeAttachmentName('what?<is>:"this"|*.md'), "what__is___this___.md");
  assert.equal(sanitizeAttachmentName("  spaced   name.txt  "), "spaced name.txt");
  const long = sanitizeAttachmentName(`${"x".repeat(300)}.png`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".png"));
});

test("each attachment is stored privately in its own folder", async () => {
  const root = join(base, "store");
  const first = await saveAttachment(root, "../notes.md", Buffer.from("one"));
  const second = await saveAttachment(root, "notes.md", Buffer.from("two"));
  assert.notEqual(first, second);
  for (const [path, body] of [[first, "one"], [second, "two"]]) {
    assert.equal(basename(path), "notes.md");
    assert.equal(dirname(dirname(path)), root);
    assert.equal(readFileSync(path, "utf8"), body);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  }
});

test("request bodies above the file limit are refused", async (t) => {
  const server = createServer(async (request, response) => {
    try {
      const body = await readAttachmentBody(request);
      response.writeHead(200).end(String(body.length));
    } catch (error) {
      response.writeHead(error instanceof AttachmentTooLarge ? 413 : 500, { Connection: "close" }).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const small = await fetch(url, { method: "POST", body: Buffer.alloc(1024) });
  assert.equal(await small.text(), "1024");
  const large = await fetch(url, { method: "POST", body: Buffer.alloc(attachmentLimits.maxFileBytes + 1) });
  assert.equal(large.status, 413);
});

test("Claude reads attachments without asking, but nothing else nearby", async () => {
  const root = join(base, "claude");
  const server = new ClaudeAppServer(undefined, (() => { throw new Error("unused"); }) as any, { readableRoots: [root] });
  const handler = (server as any).permissionHandler("thread-1");
  (server as any).runs.set("thread-1", { finished: false, turn: { id: "turn-1" }, requests: new Set(),
    writeTurn: false, toolFolders: new Map(), agentNames: new Map() });
  // Anything not allowed outright goes to the user, who declines here.
  const asked: string[] = [];
  (server as any).request = async (method: string) => { asked.push(method); return { decision: "decline" }; };
  const signal = new AbortController().signal;
  const read = { file_path: join(root, "id", "notes.md") };
  assert.deepEqual(await handler("Read", read, { signal }), { behavior: "allow", updatedInput: read });
  assert.equal((await handler("Grep", { pattern: "x", path: root }, { signal })).behavior, "allow");
  assert.deepEqual(asked, []);
  assert.equal((await handler("Read", { file_path: join(root, "..", "secret") }, { signal, agentID: "a" })).behavior, "deny");
  assert.equal((await handler("Write", { file_path: join(root, "id", "notes.md") }, { signal, agentID: "a" })).behavior, "deny");
  assert.deepEqual(asked, ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
});

test("the attachments endpoint stores a file from the workspace page and returns its path", async (t) => {
  const state = mkdtempSync(join(base, "server-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  // A demo workspace keeps dropped files under the temporary folder, which points into this test's state here.
  const server = spawn(process.execPath, [fileURLToPath(new URL("../src/workspace-server.ts", import.meta.url))], {
    env: { ...process.env, ORCHESTRA_PORT: String(port), ORCHESTRA_STATE_DIR: state, TMPDIR: state }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const origin = await new Promise<string>((resolve, reject) => {
    server.stdout.on("data", (chunk: Buffer) => {
      const found = /available at (http:\/\/\S+)/.exec(String(chunk));
      if (found) resolve(found[1]);
    });
    server.once("exit", (code) => reject(new Error(`Server exited with ${code}`)));
  });
  const upload = (name: string, headers: Record<string, string>) => fetch(`${origin}/api/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST", headers, body: "hello",
  });

  const stored = await upload("../../escape.txt", { Origin: origin, "Content-Type": "application/octet-stream" });
  assert.equal(stored.status, 200);
  const { path } = await stored.json();
  assert.equal(basename(path), "escape.txt");
  assert.ok(path.startsWith(join(state, "orchestra-demo-attachments")));
  assert.equal(readFileSync(path, "utf8"), "hello");

  assert.equal((await upload("a.txt", { "Content-Type": "application/octet-stream" })).status, 403, "requires the page origin");
  assert.equal((await upload("a.txt", { Origin: "http://evil.test", "Content-Type": "application/octet-stream" })).status, 403);
  assert.equal((await upload("a.txt", { Origin: origin, "Content-Type": "text/plain" })).status, 403);
  assert.equal((await fetch(`${origin}/api/attachments`)).status, 404, "stored files are never served back");
});
