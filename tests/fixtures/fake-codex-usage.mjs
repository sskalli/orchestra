#!/usr/bin/env node
import { basename } from "node:path";
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
function emit(method, params) {
  write({ method, params });
}

function breakdown(inputTokens) {
  return { inputTokens, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0, totalTokens: inputTokens };
}

function usage(threadId, turnId, total, last) {
  emit("thread/tokenUsage/updated", {
    threadId, turnId, tokenUsage: { total: breakdown(total), last: breakdown(last), modelContextWindow: 1_000 },
  });
}

const complete = (threadId, turn) =>
  emit("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
const restartDuringTurn = basename(process.cwd()).startsWith("orchestra-usage-recovery-");
let nextThread = 0;
let rejectNextThread = false;
const pendingToolCalls = new Map();

function callTool(threadId, turn, tool, args) {
  const id = `tool-${turn.id}`;
  pendingToolCalls.set(id, { threadId, turn });
  write({ id, method: "item/tool/call", params: { threadId, turnId: turn.id, tool, arguments: args } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { method, id, params } = JSON.parse(line);
  const reply = (result) => write({ id, result });
  if (method === "initialize") reply({});
  if (method === "account/read") reply({ account: { type: "chatgpt" } });
  if (method === "config/read") reply({ config: { model_provider: null } });
  if (method === "model/list") reply({ data: [] });
  if (method === "thread/start") {
    if (rejectNextThread) {
      rejectNextThread = false;
      write({ id, error: { code: -32000, message: "Fixture rejected a child thread" } });
      return;
    }
    reply({ thread: { id: `thread-${++nextThread}` }, modelProvider: params.modelProvider });
  }
  if (method === "thread/resume") {
    const thread = { id: params.threadId, status: { type: "idle" } };
    if (params.threadId === "thread-1") {
      if (restartDuringTurn) {
        usage(thread.id, "interrupted checkpoint", 100, 100);
        thread.turns = [{ id: "interrupted checkpoint", rootTurnId: null, status: "completed" }];
      } else {
        usage(thread.id, "initial", 160, 60);
      }
    }
    reply({ thread, modelProvider: params.modelProvider });
  }
  if (!method && pendingToolCalls.has(id)) {
    const { threadId, turn } = pendingToolCalls.get(id);
    pendingToolCalls.delete(id);
    complete(threadId, turn);
  }
  if (method !== "turn/start") return;
  const { threadId } = params;
  const text = params.input[0].text;
  if (text === "rejected instruction") {
    write({ id, error: { code: -32000, message: "Fixture rejected a relay turn" } });
    return;
  }
  const turn = { id: text, rootTurnId: params.rootTurnId ?? null, status: "inProgress" };
  if (text === "initial") usage(threadId, turn.id, 100, 100);
  reply({ turn });
  emit("turn/started", { threadId, turn });
  if (text === "initial") {
    usage(threadId, turn.id, 160, 60);
    usage(threadId, turn.id, 160, 60);
    callTool(threadId, turn, "delegate_agent", { name: "Fixture lead", duty: "lead", goal: "child" });
    return;
  }
  if (text === "child") {
    complete(threadId, turn);
    usage(threadId, turn.id, 40, 40);
    return;
  }
  if (text === "interrupted checkpoint") {
    usage(threadId, turn.id, 100, 100);
    return;
  }
  if (text === "rejected child start") {
    rejectNextThread = true;
    callTool(threadId, turn, "delegate_agent", { name: "Rejected lead", duty: "lead", goal: "rejected child" });
    return;
  }
  if (text.startsWith("relay to ")) {
    callTool(threadId, turn, "message_agent", { agentId: text.slice("relay to ".length), goal: "rejected instruction" });
    return;
  }
  if (text === "after restart") {
    if (restartDuringTurn) usage(threadId, turn.id, 170, 20);
    else usage(threadId, turn.id, 190, 30);
  }
  complete(threadId, turn);
});
