import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { explainApproval, remoteHost, toolCacheFolders } from "../src/claude-permissions.ts";

test("Git remote URLs give the host a repository task may reach", () => {
  assert.equal(remoteHost("https://github.com/team/app.git"), "github.com");
  assert.equal(remoteHost("ssh://git@GitLab.example.com:2222/team/app.git"), "gitlab.example.com");
  assert.equal(remoteHost("git@github.com:team/app.git"), "github.com");
  assert.equal(remoteHost("/srv/git/app.git"), undefined, "a local remote has no host");
  assert.equal(remoteHost("file:///srv/git/app.git"), undefined);
  assert.equal(remoteHost("../app.git"), undefined);
});

test("only tool caches that exist become writable", (t) => {
  const home = mkdtempSync(join(tmpdir(), "orchestra-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".npm"));
  mkdirSync(join(home, ".cache"));
  assert.deepEqual(toolCacheFolders(home, "linux"), [join(home, ".npm"), join(home, ".cache")]);
});

test("approval cards say in plain words why the user is asked", () => {
  const uncheckable = explainApproval({ toolName: "Bash", input: { command: "for b in a; do echo $b; done" }, writeTurn: false,
    decisionReason: "Contains brace with quote character (expansion obfuscation)" });
  assert.equal(uncheckable.summary, "Permission requested to run a command.");
  assert.match(uncheckable.reason, /can't check what this command does before it runs/);
  assert.doesNotMatch(uncheckable.reason, /obfuscation/, "Claude Code's internal wording is translated");

  const outside = explainApproval({ toolName: "Bash", input: { command: "npm ci", dangerouslyDisableSandbox: true }, writeTurn: true });
  assert.equal(outside.summary, "Permission requested to run a command outside the sandbox.");

  const network = explainApproval({ toolName: "SandboxNetworkAccess", input: { host: "api.github.com" }, writeTurn: true, requestedBy: "" });
  assert.equal(network.summary, "Permission requested to connect to api.github.com.");
  assert.equal(network.host, "api.github.com");
  assert.match(network.reason, /^Asked by a background agent\. /);

  const fetch = explainApproval({ toolName: "WebFetch", input: { url: "https://example.com" }, writeTurn: true,
    title: "Claude wants to fetch example.com", description: "Reads one web page." });
  assert.equal(fetch.summary, "Permission requested to fetch a page from example.com.");
  assert.match(fetch.reason, /read https:\/\/example\.com with WebFetch/);

  const other = explainApproval({ toolName: "mcp__notes__save", input: {}, writeTurn: true,
    title: "Claude wants to save a note", description: "Writes to the notes server." });
  assert.equal(other.summary, "Claude wants to save a note");
  assert.equal(other.reason, "Writes to the notes server.");
});
