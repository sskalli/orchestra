#!/usr/bin/env node
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
let nextThread = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const { method, id, params } = JSON.parse(line);
  const reply = (result) => write({ id, result });
  if (method === "initialize") reply({});
  if (method === "account/read") reply({ account: { type: "chatgpt" } });
  if (method === "config/read") reply({ config: { model_provider: null } });
  if (method === "model/list") reply({ data: [] });
  if (method === "thread/start") reply({ thread: { id: `thread-${++nextThread}` }, modelProvider: params.modelProvider });
  if (method === "thread/resume") {
    if (params.threadId === "thread-1") usage("thread-1", "initial", 160, 60);
    reply({ thread: { id: params.threadId, status: { type: "idle" } }, modelProvider: params.modelProvider });
  }
  if (!method && id === "delegate") complete("thread-1", { id: "initial", rootTurnId: null });
  if (method !== "turn/start") return;
  const { threadId } = params;
  const text = params.input[0].text;
  const turn = { id: text, rootTurnId: params.rootTurnId ?? null, status: "inProgress" };
  if (text === "initial") usage(threadId, turn.id, 100, 100);
  reply({ turn });
  emit("turn/started", { threadId, turn });
  if (text === "initial") {
    usage(threadId, turn.id, 160, 60);
    usage(threadId, turn.id, 160, 60);
    write({ id: "delegate", method: "item/tool/call", params: {
      threadId, turnId: turn.id, tool: "delegate_agent",
      arguments: { name: "Fixture lead", duty: "lead", goal: "child" },
    } });
    return;
  }
  if (text === "child") {
    complete(threadId, turn);
    usage(threadId, turn.id, 40, 40);
    return;
  }
  if (text === "after restart") usage(threadId, turn.id, 190, 30);
  complete(threadId, turn);
});
