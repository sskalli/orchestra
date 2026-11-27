import assert from "node:assert/strict";
import { test } from "node:test";
import { staleStreamMs, watchEventStream, type EventStream } from "../src/workspace-event-stream.ts";

class FakeStream implements EventStream {
  readyState = 1;
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly listeners = new Map<string, (event: { data: string }) => void>();
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; this.readyState = 2; }
  emit(type: string, data = "{}") {
    if (type === "message") this.onmessage?.({ data });
    else this.listeners.get(type)?.({ data });
  }
}

function setup() {
  let time = 0;
  let tick: (() => void) | undefined;
  const streams: FakeStream[] = [];
  const connected: boolean[] = [];
  const snapshots: string[] = [];
  const page = new EventTarget() as EventTarget & { visibilityState: string };
  page.visibilityState = "visible";
  const network = new EventTarget();
  const stop = watchEventStream({
    onSnapshot: (data) => snapshots.push(data),
    onSignal: () => {},
    onConnected: (value) => connected.push(value),
  }, {
    open: () => { const stream = new FakeStream(); streams.push(stream); return stream; },
    now: () => time,
    setInterval: (run) => { tick = run; return 1; },
    clearInterval: () => { tick = undefined; },
    page, network,
  });
  return { streams, connected, snapshots, page, network, stop,
    advance: (ms: number) => { time += ms; tick?.(); },
    /** Time passing while a background tab's timers are throttled. */
    sleep: (ms: number) => { time += ms; } };
}

test("the page reconnects a stream that went silent, closed, or was away while the page was hidden", () => {
  const { streams, connected, snapshots, page, network, stop, advance, sleep } = setup();
  assert.equal(streams.length, 1);
  streams[0].emit("message", "first");
  assert.deepEqual(snapshots, ["first"]);
  assert.deepEqual(connected, [true]);

  // Heartbeats keep a quiet but healthy stream.
  for (let elapsed = 0; elapsed < staleStreamMs * 2; elapsed += 15_000) {
    streams[0].emit("heartbeat");
    advance(15_000);
  }
  assert.equal(streams.length, 1);

  // A stream that stops sending anything is replaced, and the page shows it is reconnecting meanwhile.
  advance(staleStreamMs + 1);
  assert.equal(streams.length, 2);
  assert.equal(streams[0].closed, true);
  assert.equal(connected.at(-1), false);
  streams[1].emit("message", "second");
  assert.equal(connected.at(-1), true);

  // A stream the browser gave up on is replaced at the next check.
  streams[1].close();
  advance(1);
  assert.equal(streams.length, 3);

  // An error alone leaves retrying to the browser.
  streams[2].onerror?.({});
  assert.equal(connected.at(-1), false);
  assert.equal(streams.length, 3);

  // Coming back to the page or the network checks right away instead of waiting for the next watchdog tick.
  streams[2].emit("message", "third");
  page.visibilityState = "hidden";
  sleep(staleStreamMs * 3);
  page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(streams.length, 3, "nothing happens while the page stays hidden");
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(streams.length, 4);
  streams[3].emit("message", "fresh");
  page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(streams.length, 4, "a fresh stream is kept");
  streams[3].close();
  network.dispatchEvent(new Event("online"));
  assert.equal(streams.length, 5);

  stop();
  assert.equal(streams[4].closed, true);
  network.dispatchEvent(new Event("online"));
  assert.equal(streams.length, 5, "a stopped watcher does nothing");
});
