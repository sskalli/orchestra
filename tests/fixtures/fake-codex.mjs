#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

let nextThread = 0;
let nextTurn = 0;
let nextRequest = 0;
const pending = new Map();
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const trace = (value) => appendFileSync(process.env.ORCHESTRA_TEST_TRACE, JSON.stringify(value) + "\n");
const complete = (threadId, turn) => write({ method: "turn/completed", params: {
  threadId, turn: { ...turn, status: "completed" },
} });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      trace({ method: "tool/result", result: message.result });
      complete(request.threadId, request.turn);
    }
    return;
  }
  const { method, params = {}, id } = message;
  if (method === "initialized") return;
  trace({ method, params });
  if (method === "initialize") write({ id, result: {} });
  else if (method === "account/read") write({ id, result: { account: { type: "chatgpt" } } });
  else if (method === "thread/start") {
    write({ id, result: { thread: { id: `thread-${++nextThread}` }, modelProvider: params.modelProvider } });
  } else if (method === "thread/resume") {
    write({ id, result: { thread: { id: params.threadId, status: { type: "idle" } }, modelProvider: params.modelProvider } });
  } else if (method === "turn/start") {
    const turn = { id: `turn-${++nextTurn}`, rootTurnId: null, status: "inProgress" };
    write({ id, result: { turn } });
    write({ method: "turn/started", params: { threadId: params.threadId, turn } });
    const text = params.input?.[0]?.text ?? "";
    if (text.startsWith("delegate:")) {
      const [, projectId, duty, goal, afterAgentId] = text.split(":");
      const requestId = `tool-${++nextRequest}`;
      pending.set(requestId, { threadId: params.threadId, turn });
      write({ id: requestId, method: "item/tool/call", params: {
        threadId: params.threadId, turnId: turn.id, tool: "delegate_agent",
        arguments: { name: `${projectId || "inherited"}-${duty}`, duty, goal,
          ...(projectId ? { projectId } : {}), ...(afterAgentId ? { afterAgentId } : {}) },
      } });
    } else {
      complete(params.threadId, turn);
    }
  }
});
