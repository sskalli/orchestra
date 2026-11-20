#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const emit = (method, params) => write({ method, params });
const record = (event) => appendFileSync(process.env.ORCHESTRA_TEST_TEAM_TRACE, JSON.stringify(event) + "\n");
const cwdByThread = new Map();
const totalsByThread = new Map();
const pending = new Map();
let nextThread = 0;
let nextTurn = 0;
let nextTool = 0;

function callTool(state, tool, args) {
  const id = `tool-${++nextTool}`;
  pending.set(id, { ...state, tool });
  write({ id, method: "item/tool/call", params: { threadId: state.threadId, turnId: state.turn.id, tool, arguments: args } });
}

function complete({ threadId, turn }) {
  emit("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { method, id, params, result } = JSON.parse(line);
  const reply = (result) => write({ id, result });
  if (!method && pending.has(id)) {
    const state = pending.get(id);
    pending.delete(id);
    record({ type: "tool-result", tool: state.tool, result });
    if (state.steps) {
      const [step, ...steps] = state.steps;
      if (step) callTool({ ...state, steps }, ...step);
      else complete(state);
    } else if (state.tool === "find_archived_team" && result.success) {
      callTool(state, "delegate_agent", {
        name: "Fresh coder", duty: "coder", goal: "Implement the next task",
        ...(state.wrongProject && { projectId: "other" }),
      });
    } else if (state.tool === "delegate_agent" && result.success) {
      const delegation = JSON.parse(result.contentItems[0].text);
      callTool(state, "confirm_implementation", { agentId: delegation.id });
    } else {
      complete(state);
    }
    return;
  }
  if (method === "initialize") reply({});
  if (method === "account/read") reply({ account: { type: "chatgpt" } });
  if (method === "config/read") reply({ config: { model_provider: null } });
  if (method === "model/list") reply({ data: [] });
  if (method === "thread/start") {
    const thread = { id: `fresh-thread-${process.pid}-${++nextThread}` };
    cwdByThread.set(thread.id, params.cwd);
    record({ type: method, threadId: thread.id });
    reply({ thread, modelProvider: params.modelProvider });
  }
  if (method === "thread/resume") {
    record({ type: method, threadId: params.threadId });
    cwdByThread.set(params.threadId, params.cwd);
    reply({ thread: { id: params.threadId, status: { type: "idle" } }, modelProvider: params.modelProvider });
  }
  if (method !== "turn/start") return;
  const { threadId } = params;
  const text = params.input[0].text;
  const turn = { id: `turn-${process.pid}-${++nextTurn}`, rootTurnId: params.rootTurnId ?? null, status: "inProgress" };
  const state = { threadId, turn };
  record({ type: method, text, threadId, context: params.additionalContext });
  reply({ turn });
  emit("turn/started", state);
  const previous = totalsByThread.get(threadId) ?? 0;
  const total = previous + 20;
  totalsByThread.set(threadId, total);
  const counts = (amount) => ({
    totalTokens: amount, inputTokens: amount, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
  });
  emit("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { total: counts(total), last: counts(20) } });

  if (text.startsWith("Reuse team Contact Form to")) {
    callTool({ ...state, steps: [
      ["find_archived_team", { name: "Contact" }],
    ] }, "delegate_agent", { name: "Premature analyser", duty: "analyser", goal: "Premature", projectId: "other" });
  } else if (text.startsWith("Reuse Contact Form to")) {
    callTool({ ...state, steps: [
      ["delegate_agent", { name: "Premature analyser", duty: "analyser", goal: "Premature", projectId: "other" }],
      ["find_archived_team", { name: "Contact Form" }],
      ["delegate_agent", { name: "Contact analyser", duty: "analyser", goal: "Read the handoff" }],
    ] }, "find_archived_team", { name: "Contact" });
  } else if (text.includes("Legacy squad") || text.includes("legacy-lead")) {
    const name = text.includes("legacy-lead") ? "legacy-lead" : "Legacy squad";
    callTool({ ...state, wrongProject: text.includes("in the other repository") }, "find_archived_team", { name });
  } else if (text === "Implement the next task") {
    writeFileSync(join(cwdByThread.get(threadId), "README.md"), "Fresh candidate\n");
    emit("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "report", delta: "Updated README.md and checked the diff." });
    complete(state);
  } else {
    complete(state);
  }
});
