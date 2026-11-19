import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceStore } from "../src/workspace-store.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex-usage.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for usage fixture.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("workspace attributes early and late usage to the root run across delegation and replay", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "orchestra-usage-test-"));
  const store = workspaceStore(project, join(project, "state"));
  let runtime = new WorkspaceRuntime({ cwd: project, store });
  t.after(async () => {
    await runtime.close();
    rmSync(project, { recursive: true, force: true });
  });

  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  const send = (agentId: string, text: string) => runtime.command({ type: "send", agentId, text });
  const total = () => runtime.snapshot().usage?.total;
  await send("coordinator", "initial");
  await waitFor(() => total()?.tokens?.inputTokens === 200 &&
    runtime.snapshot().agents.every((agent) => agent.status === "done"));
  const lead = runtime.snapshot().agents.find((agent) => agent.role === "lead");
  assert(lead);
  const rootMessage = runtime.snapshot().agents.find((agent) => agent.id === "coordinator")?.messages
    .find((message) => message.role === "user");
  assert(rootMessage);
  let exported = runtime.usageExport();
  assert.equal(exported?.byRun[rootMessage.id].tokens?.inputTokens, 200);
  assert.equal(exported?.byAgent.coordinator.tokens?.inputTokens, 160);
  assert.equal(exported?.byTeam[lead.id].tokens?.inputTokens, 40);
  assert.equal(exported?.decisions.length, 1);

  await send(lead.id, "unreported");
  await waitFor(() => total()?.unknownTurns === 1);
  assert.equal(total()?.tokens?.inputTokens, 200);
  assert.equal(total()?.observedTurns, 2);

  await runtime.close();
  runtime = new WorkspaceRuntime({ cwd: project, store });
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert.equal(total()?.tokens?.inputTokens, 200);
  assert.equal(total()?.unknownTurns, 1);
  await send("coordinator", "after restart");
  await waitFor(() => total()?.tokens?.inputTokens === 230);
  exported = runtime.usageExport();
  assert.equal(exported?.byRun[rootMessage.id].tokens?.inputTokens, 200);
  assert.equal(exported?.byAgent.coordinator.tokens?.inputTokens, 190);
  assert.equal(exported?.byAgent[lead.id].unknownTurns, 1);
  assert.equal(exported?.total.observedTurns, 3);

  await runtime.command({ type: "archive", agentId: lead.id });
  assert.equal(runtime.usageExport()?.total.tokens?.inputTokens, 230);
  await runtime.command({ type: "delete", agentId: lead.id });
  assert.equal(runtime.usageExport()?.total.tokens?.inputTokens, 190);
  assert.equal(runtime.usageExport()?.byAgent[lead.id], undefined);
  assert.equal(runtime.usageExport()?.byTeam[lead.id], undefined);
  assert.equal(runtime.usageExport()?.byRun[rootMessage.id].tokens?.inputTokens, 160);
  assert.equal(runtime.usageExport()?.decisions.some((decision) => decision.delegateId === lead.id), false);

  await runtime.close();
  runtime = new WorkspaceRuntime({ cwd: project, store });
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert.equal(runtime.usageExport()?.total.tokens?.inputTokens, 190);
  assert.equal(runtime.usageExport()?.turns.some((turn) => turn.attribution?.agentId === lead.id), false);
});
