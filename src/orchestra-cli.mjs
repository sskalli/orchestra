#!/usr/bin/env node
// orchestra [codex | claude | codex:<provider> | demo] [path | --project ID=path ...]
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const usage = `Usage:
  orchestra codex  [path | --project ID=path ...]   Codex with your ChatGPT sign-in
  orchestra claude [path | --project ID=path ...]   Claude Code with your Claude sign-in
  orchestra codex:<provider> [path ...]             Codex with a provider from ~/.codex/config.toml
  orchestra demo                                    Simulated workspace, no sign-in needed

Without a path, Orchestra opens the current Git repository.
Codex starts on port 4317 and Claude on 4327; each moves to the next free port.`;

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name) {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => directory && executable(join(directory, name)));
}

function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (onPath("codex")) return "codex";
  return ["/usr/lib/chatgpt/resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex"].find(executable);
}

function claudeBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  return onPath("claude") ? "claude" : undefined;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await prompt.question(`${question} [Y/n] `)).trim());
  } finally {
    prompt.close();
  }
}

/** Checks the sign-in and offers to run the login flow, so a launch never ends in a signed-out workspace. */
async function ensureSignedIn(engine, provider) {
  if (engine === "claude") {
    const binary = claudeBinary();
    if (!binary) {
      console.log("Claude Code CLI not found on PATH; skipping the sign-in check. Set CLAUDE_BIN to check it.");
      return;
    }
    const status = spawnSync(binary, ["auth", "status"], { encoding: "utf8" });
    let loggedIn = false;
    try { loggedIn = JSON.parse(status.stdout).loggedIn === true; } catch { loggedIn = status.status === 0; }
    if (loggedIn) return;
    console.log("Claude Code is not signed in.");
    if (!(await confirm("Sign in now?"))) throw new Error(`Run \`${binary} auth login\`, then launch again.`);
    if (spawnSync(binary, ["auth", "login"], { stdio: "inherit" }).status !== 0) throw new Error("Claude sign-in did not finish.");
    return;
  }
  const binary = codexBinary();
  if (!binary) throw new Error("Codex was not found. Install it or set CODEX_BIN to its path.");
  process.env.CODEX_BIN = binary;
  // A custom provider authenticates with its own environment variable, not the ChatGPT sign-in.
  if (provider !== "openai") return;
  if (spawnSync(binary, ["login", "status"], { stdio: "ignore" }).status === 0) return;
  console.log("Codex is not signed in with ChatGPT.");
  if (!(await confirm("Sign in now?"))) throw new Error(`Run \`${binary} login\`, then launch again.`);
  if (spawnSync(binary, ["login"], { stdio: "inherit" }).status !== 0) throw new Error("Codex sign-in did not finish.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    console.log(usage);
    return;
  }
  let mode = "codex";
  if (args[0] && !args[0].startsWith("-") && /^(codex(:.+)?|claude|demo)$/.test(args[0])) mode = args.shift();
  const [engine, provider = "openai"] = mode.split(":");
  const serverArgs = [];
  if (engine === "demo") {
    if (args.length) throw new Error("The demo takes no repositories.");
  } else {
    serverArgs.push("--engine", engine);
    if (provider !== "openai") serverArgs.push("--provider", provider);
    if (args.length && !args[0].startsWith("-")) serverArgs.push("--live", args.shift());
    serverArgs.push(...args);
    await ensureSignedIn(engine, provider);
  }
  const build = spawnSync(process.execPath, [join(root, "src/build-workspace.mjs")], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) throw new Error("The workspace UI failed to build.");
  const server = spawn(process.execPath, [join(root, "src/workspace-server.ts"), ...serverArgs], { stdio: "inherit" });
  // Ctrl+C already reaches the server through the terminal's process group; forwarding it would cut shutdown short.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => server.kill("SIGTERM"));
  server.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
