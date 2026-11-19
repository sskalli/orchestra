import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { safeError } from "./app-server.ts";

type ErrorKind = "cancelled" | "signed-out" | "usage-limit" | "failed";

export class ClaudeCodeError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.kind = kind;
  }
}

type RunOptions = {
  cwd: string;
  prompt: string;
  sessionId: string;
  resume?: boolean;
  executable?: string;
  onText: (text: string) => void;
  onSession?: () => void;
};

type StreamMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  error?: string;
  errors?: string[];
  result?: string;
  event?: {
    type?: string;
    content_block?: { type?: string; text?: string };
    delta?: { type?: string; text?: string };
  };
  message?: { content?: { type: string; text?: string }[] };
};

const diagnosticLimit = 4_096;
const signInMessage = "Claude Code needs authentication. Configure it in the Claude Code CLI, then restart the workspace.";

function missingExecutable() {
  return new ClaudeCodeError("failed", "Claude Code could not be started. Install the CLI or set CLAUDE_BIN to its executable path, and check that the project directory still exists.");
}

function turnError(detail: string, category?: string) {
  if (category === "authentication_failed" || /not logged in|run \/login|authentication (?:failed|required)|invalid api key|oauth token has expired|\b401\b/i.test(detail)) {
    return new ClaudeCodeError("signed-out", signInMessage);
  }
  if (category === "rate_limit" || /rate[_ -]limit|usage limit|hit your (?:\w+ )?limit|\b429\b/i.test(detail)) {
    return new ClaudeCodeError("usage-limit", "Claude Code reached a usage or rate limit. Check the CLI for details before restarting the workspace.");
  }
  return new ClaudeCodeError("failed", safeError(detail).slice(0, diagnosticLimit));
}

export function checkClaudeCode(cwd: string, executable = process.env.CLAUDE_BIN ?? "claude") {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(executable, ["auth", "status"], { cwd, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: diagnosticLimit }, (error, _stdout, stderr) => {
      // The CLI reports authentication via its exit code. Stdout may contain account details.
      if (!error) resolve();
      else if (error.code === 1) reject(new ClaudeCodeError("signed-out", signInMessage));
      else if (error.code === "ENOENT") reject(missingExecutable());
      else reject(turnError(stderr.trim() || "Claude Code could not report authentication status. Run `claude auth status` to diagnose."));
    });
    child.stdin?.end();
  });
}

export function runClaudeCode({
  cwd, prompt, sessionId, resume = false, executable = process.env.CLAUDE_BIN ?? "claude", onText, onSession,
}: RunOptions) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new ClaudeCodeError("failed", "Claude Code requires a UUID to start or resume a session.");
  }
  const env = { ...process.env };
  delete env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
  const child = spawn(executable, [
    "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--restricted", "--tools", "", "--disable-slash-commands", "--no-chrome",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "*",
    "--permission-mode", "dontAsk",
    "--settings", '{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
    resume ? "--resume" : "--session-id", sessionId,
  ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  let result: StreamMessage | undefined;
  let assistantError: { category: string; detail: string } | undefined;
  let failure: Error | undefined;
  let inputError: Error | undefined;
  let cancelled = false;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let streamedMessage = false;
  let emittedText = "";

  function stop() {
    if (closed || killTimer) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // A child of the CLI can keep inherited pipes open after the CLI exits.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, 2_000);
  }

  function emit(text: string) {
    if (!text) return;
    emittedText += text;
    onText(text);
  }

  const completion = new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-diagnosticLimit);
    });
    child.stdin.on("error", (error) => {
      // An early CLI rejection can close stdin before the diagnostic arrives.
      inputError = error;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= error.code === "ENOENT" ? missingExecutable() : turnError(error.message);
    });
    lines.on("error", () => {
      failure ??= turnError("Could not read Claude Code output.");
      stop();
    });
    lines.on("line", (line) => {
      if (!line.trim() || cancelled || failure) return;
      try {
        const message = JSON.parse(line) as StreamMessage;
        if (typeof message?.type !== "string") throw new Error();
        if (message.parent_tool_use_id) return;
        if (message.session_id && message.session_id !== sessionId) {
          failure = turnError("Claude Code returned a different session ID.");
          stop();
          return;
        }
        if (message.type === "stream_event") {
          const event = message.event;
          if (event?.type === "message_start") streamedMessage = false;
          const block = event?.type === "content_block_start" && event.content_block?.type === "text"
            ? event.content_block
            : event?.type === "content_block_delta" && event.delta?.type === "text_delta" ? event.delta : undefined;
          if (typeof block?.text === "string" && block.text) {
            streamedMessage = true;
            emit(block.text);
          }
        } else if (message.type === "assistant") {
          const text = message.message?.content
            ?.filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text).join("") ?? "";
          if (typeof message.error === "string") assistantError = { category: message.error, detail: text };
          else if (!streamedMessage) emit(text);
        } else if (message.type === "result") {
          result = message;
        }
      } catch {
        failure = turnError("Claude Code returned invalid streaming JSON.");
        stop();
      }
    });
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(killTimer);
      lines.close();
      if (cancelled) reject(new ClaudeCodeError("cancelled", "Claude Code turn cancelled."));
      else if (failure) reject(failure);
      else if (code !== 0 || !result || result.is_error !== false || result.subtype !== "success" || assistantError) {
        const details = [assistantError?.detail, result?.result, ...(Array.isArray(result?.errors) ? result.errors : []), stderr]
          .filter((detail): detail is string => typeof detail === "string" && !!detail.trim());
        const fallback = inputError?.message ?? (code === 0
          ? "Claude Code exited without a successful result."
          : `Claude Code exited (${signal ?? `code ${code}`}).`);
        reject(turnError(details.join("\n") || fallback, assistantError?.category ?? result?.error));
      } else if (result.session_id !== sessionId) {
        reject(turnError("Claude Code did not confirm the requested session ID."));
      } else {
        try {
          if (typeof result.result === "string" && result.result.startsWith(emittedText)) {
            emit(result.result.slice(emittedText.length));
          }
          onSession?.();
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(prompt);
  });

  return {
    completion,
    cancel() {
      if (closed || cancelled) return;
      cancelled = true;
      stop();
    },
  };
}
