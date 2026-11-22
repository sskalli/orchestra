#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

let nextThread = 0;
let nextTurn = 0;
const pending = new Map();
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const emit = (method, params) => write({ method, params });
const trace = (method, params) => appendFileSync(process.env.ORCHESTRA_TEST_TRACE, JSON.stringify({ method, params }) + "\n");
const finish = (threadId, turn) => emit("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
const assistant = (threadId, turnId, id, text) => emit("item/completed", {
  threadId, turnId, item: { type: "agentMessage", id, text },
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const { method, params = {}, id, result } = JSON.parse(line);
  if (!method) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    trace("product-decision/result", result);
    finish(request.threadId, request.turn);
    return;
  }
  if (method === "initialized") return;
  trace(method, params);
  const reply = (value) => write({ id, result: value });
  if (method === "initialize") reply({});
  else if (method === "account/read") reply({ account: { type: "chatgpt" } });
  else if (method === "config/read") reply({ config: { model_provider: null } });
  else if (method === "model/list") reply({ data: [] });
  else if (method === "thread/start" || method === "thread/resume") {
    reply({ thread: { id: params.threadId ?? `fixture-thread-${++nextThread}`, status: { type: "idle" } },
      modelProvider: params.modelProvider, model: params.model ?? "fixture-default" });
  } else if (method === "thread/read") {
    reply({ thread: { id: params.threadId, parentThreadId: params.threadId.replace(/-child$/, ""),
      status: { type: "idle" }, turns: [{ id: "child-turn", status: "completed", items: [
        { type: "agentMessage", id: "child-report", text: "Native child found ORBIT-42." },
      ] }] } });
  } else if (method === "turn/start") {
    const { threadId } = params;
    const turn = { id: `fixture-turn-${process.pid}-${++nextTurn}`, rootTurnId: null, status: "inProgress" };
    reply({ turn });
    emit("turn/started", { threadId, turn });
    const text = params.input?.[0]?.text ?? "";
    if (text.includes("Fixture rejection: use the wrong release.")) {
      emit("turn/completed", { threadId, turn: { ...turn, status: "failed", error: { message: "Fixture rejected the answer." } } });
      return;
    }
    if (text === "Inspect the release notes and ask which release to use.") {
      const childId = `${threadId}-child`;
      const activity = (kind) => emit("item/completed", { threadId, turnId: turn.id, item: {
        type: "subAgentActivity", id: `native-${kind}`, kind, agentThreadId: childId, agentPath: "/notes",
      } });
      activity("started");
      assistant(childId, "child-turn", "child-report", "Native child found ORBIT-42.");
      activity("completed");
    }
    const question = new Map([
      ["Inspect the release notes and ask which release to use.", "Use ORBIT-42 for the release?"],
      ["Ask whether to publish the draft.", "Publish the draft now?"],
    ]).get(text);
    if (question) {
      const requestId = `question-${turn.id}`;
      pending.set(requestId, { threadId, turn });
      write({ id: requestId, method: "item/tool/call", params: {
        threadId, turnId: turn.id, tool: "raise_product_decision", arguments: { question },
      } });
    } else {
      assistant(threadId, turn.id, `reply-${turn.id}`, text === "Draft a short heading." ? "A solo release heading." : "Received the answer.");
      finish(threadId, turn);
    }
  } else {
    write({ id, error: { code: -32601, message: `Unexpected fixture RPC ${method}` } });
  }
});
