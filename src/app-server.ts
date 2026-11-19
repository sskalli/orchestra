import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type Id = string | number;
export type Turn = { id: string; rootTurnId: string | null; status: string; error?: { message: string } };
export type Thread = { id: string };
type Params = {
  threadId?: string;
  turnId?: string;
  turn?: Turn;
  item?: { type: string; text?: string };
  itemId?: string;
  command?: string | null;
  kind?: string;
  requestId?: Id;
  callId?: string;
  namespace?: string | null;
  tool?: string;
  arguments?: Record<string, unknown>;
  error?: { message: string };
  willRetry?: boolean;
  message?: string;
};
type Message = { id?: Id; method?: string; params?: Params; result?: unknown; error?: { code: number; message: string } };
export type Event = Message & { method: string; params: Params };
export const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS ?? "120000");
export const command = process.env.CODEX_BIN ?? "codex";

export function log(event: string, details: object = {}) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\n");
}

export function safeError(error: unknown) {
  return String(error)
    .replace(/(Bearer\s+)[\w.~-]+/gi, "$1[redacted]")
    .replace(/\bsk-[\w-]+/g, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]");
}

export class AppServer {
  private readonly child;
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private readonly events: Event[] = [];
  private readonly observers = new Set<() => void>();
  private failure?: Error;
  private closing = false;
  private readonly retainEvents: boolean;

  onEvent?: (event: Event) => void;
  onRequest?: (request: Event & { id: Id }) => Promise<void>;
  onFailure?: (error: Error) => void;

  constructor(cwd: string, environment = process.env, retainEvents = true, preserveApiKeys = false) {
    this.retainEvents = retainEvents;
    const env = { ...environment };
    if (!preserveApiKeys) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    }
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
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
    for (const observer of this.observers) observer();
    this.onFailure?.(error);
  }

  private receive(message: Message) {
    if (message.method) {
      const event = { ...message, method: message.method, params: message.params ?? {} };
      if (event.id !== undefined) {
        const request = { ...event, id: event.id };
        if (!this.onRequest) throw new Error(`Unhandled server request ${request.method}`);
        // Dispatch first so observers only select requests held for this scenario.
        void this.onRequest(request).catch((error: Error) => this.fail(error));
        if (this.retainEvents) this.events.push(request);
        for (const observer of this.observers) observer();
      } else {
        this.onEvent?.(event);
        if (["turn/completed", "serverRequest/resolved", "item/completed"].includes(event.method)) {
          if (this.retainEvents) this.events.push(event);
          for (const observer of this.observers) observer();
        }
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

  async call<T>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out calling ${method}`)), timeoutMs);
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

  waitFor(description: string, matches: (event: Event) => boolean): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.observers.delete(check);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs);
      const check = () => {
        const found = this.events.find(matches);
        if (!found && !this.failure) return;
        clearTimeout(timer);
        this.observers.delete(check);
        if (found) resolve(found);
        else reject(this.failure);
      };
      this.observers.add(check);
      check();
    });
  }

  matchingEvents(matches: (event: Event) => boolean) {
    return this.events.filter(matches);
  }

  close() {
    this.closing = true;
    const closed = new Error("App Server connection closed");
    for (const pending of this.pending.values()) pending.reject(closed);
    this.failure ??= closed;
    for (const observer of this.observers) observer();
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
