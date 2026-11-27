/** The server sends a heartbeat every 15 seconds; a stream silent for longer than this is treated as dead. */
export const staleStreamMs = 40_000;
const watchdogMs = 5_000;
const closedState = 2;

/** The parts of EventSource the workspace uses, so tests can pass a fake. */
export type EventStream = {
  readonly readyState: number;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
};

type Environment = {
  open: () => EventStream;
  now?: () => number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Where "online" is dispatched (the window). */
  network?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Where "visibilitychange" is dispatched (the document), and whether the page is shown. */
  page?: Pick<EventTarget, "addEventListener" | "removeEventListener"> & { readonly visibilityState: string };
};

type Handlers = {
  onSnapshot: (data: string) => void;
  onSignal: (data: string) => void;
  onConnected: (connected: boolean) => void;
};

/**
 * Keeps the workspace event stream alive. A stream can stop without an error, for example after the computer
 * sleeps, which would leave a stale snapshot that keeps the composer disabled. The browser retries a dropped
 * stream itself; this replaces one that went silent past the heartbeat interval or that the browser gave up on,
 * and checks again when the network returns or the page becomes visible. Returns a function that stops it.
 */
export function watchEventStream(handlers: Handlers, environment: Environment) {
  const now = environment.now ?? Date.now;
  let stream: EventStream | undefined;
  let lastEventAt = now();
  const seen = () => { lastEventAt = now(); };
  const connect = () => {
    stream?.close();
    seen();
    const next = environment.open();
    stream = next;
    next.onerror = () => handlers.onConnected(false);
    next.onmessage = ({ data }) => {
      seen();
      handlers.onSnapshot(data);
      handlers.onConnected(true);
    };
    next.addEventListener("heartbeat", seen);
    next.addEventListener("agent-signal", ({ data }) => {
      seen();
      handlers.onSignal(data);
    });
  };
  const reconnectIfStale = () => {
    if (!stream || stream.readyState === closedState || now() - lastEventAt > staleStreamMs) {
      handlers.onConnected(false);
      connect();
    }
  };
  const onVisible = () => { if (environment.page?.visibilityState === "visible") reconnectIfStale(); };
  connect();
  const watchdog = (environment.setInterval ?? setInterval)(reconnectIfStale, watchdogMs);
  environment.network?.addEventListener("online", reconnectIfStale);
  environment.page?.addEventListener("visibilitychange", onVisible);
  return () => {
    stream?.close();
    (environment.clearInterval ?? clearInterval)(watchdog as ReturnType<typeof setInterval>);
    environment.network?.removeEventListener("online", reconnectIfStale);
    environment.page?.removeEventListener("visibilitychange", onVisible);
  };
}
