import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type Id = string | number;
export type Turn = { id: string; rootTurnId: string | null; status: string; error?: { message: string } };
export type Thread = { id: string };
type Params = {
  threadId?: string;
  thread?: Thread & { parentThreadId?: string | null; agentNickname?: string | null; agentRole?: string | null };
  turnId?: string;
  tokenUsage?: unknown;
  turn?: Turn;
  item?: { id?: string; type: string; text?: string;
    agentThreadId?: string; agentPath?: string; agentNickname?: string | null; agentRole?: string | null;
    kind?: string; model?: string | null; changes?: { path?: unknown }[] };
  itemId?: string;
  requestId?: Id;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  availableDecisions?: unknown;
  additionalPermissions?: unknown;
  networkApprovalContext?: unknown;
  permissions?: unknown;
  grantRoot?: string | null;
  kind?: string;
  namespace?: string | null;
  tool?: string;
  arguments?: Record<string, unknown>;
  error?: { message: string };
  willRetry?: boolean;
  message?: string;
};
type Message = { id?: Id; method?: string; params?: Params; result?: unknown; error?: { code: number; message: string } };
export type Event = Message & { method: string; params: Params };
const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS ?? "120000");
const bundledCodex = ["/usr/lib/chatgpt/resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex"];

/** Finds Codex on PATH, then in the ChatGPT desktop bundle, unless CODEX_BIN names it. */
export function codexCommand(environment = process.env) {
  if (environment.CODEX_BIN) return environment.CODEX_BIN;
  const onPath = (environment.PATH ?? "").split(delimiter).some((directory) => directory && isExecutable(join(directory, "codex")));
  return onPath ? "codex" : bundledCodex.find(isExecutable) ?? "codex";
}

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The App Server protocol surface the workspace runtime depends on. */
export interface ProviderServer {
  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;
  call<T>(method: string, params: object, requestTimeoutMs?: number): Promise<T>;
  notify(method: string): void;
  reply(id: Id, result: object): void;
  reject(id: Id, message: string): void;
  close(): Promise<void>;
}

export function safeError(error: unknown) {
  return String(error)
    .replace(/(Bearer\s+)[\w.~-]+/gi, "$1[redacted]")
    .replace(/\bsk-[\w-]+/g, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]");
}

export class AppServer implements ProviderServer {
  private readonly child;
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private failure?: Error;
  private closing = false;

  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;

  constructor(cwd: string, environment = process.env) {
    const env = { ...environment };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    this.child = spawn(codexCommand(environment), ["app-server", "--listen", "stdio://"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closing) this.fail(new Error(`App Server exited (code ${code}, signal ${signal})`));
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line) as Message);
      } catch (error) {
        this.fail(new Error(`Invalid App Server message: ${safeError(error)}`));
      }
    });
  }

  private fail(error: Error) {
    if (this.failure || this.closing) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.onFailure?.(error);
  }

  private receive(message: Message) {
    if (message.method) {
      const event = { ...message, method: message.method, params: message.params ?? {} };
      if (event.id !== undefined) {
        const request = { ...event, id: event.id };
        if (!this.onRequest) throw new Error(`Unhandled server request ${request.method}`);
        void this.onRequest(request).catch((error: Error) => this.fail(error));
      } else {
        this.onEvent?.(event);
      }
      return;
    }

    if (message.id === undefined) throw new Error("Response lacks a request ID");
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new Error(`RPC ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private send(message: object) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async call<T>(method: string, params: object, requestTimeoutMs = timeoutMs): Promise<T> {
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out calling ${method}`)), requestTimeoutMs);
        this.pending.set(id, { resolve: (result) => resolve(result as T), reject });
        this.send({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  notify(method: string) {
    this.send({ method });
  }

  reply(id: Id, result: object) {
    this.send({ id, result });
  }

  reject(id: Id, message: string) {
    this.send({ id, error: { code: -32601, message } });
  }

  close() {
    this.closing = true;
    const closed = new Error("App Server connection closed");
    for (const pending of this.pending.values()) pending.reject(closed);
    this.failure ??= closed;
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const terminate = setTimeout(() => this.child.kill(), 1_000);
      const force = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
      this.child.once("close", () => {
        clearTimeout(terminate);
        clearTimeout(force);
        resolve();
      });
      this.child.stdin.end();
    });
  }
}
