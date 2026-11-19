import assert from "node:assert/strict";
import { test } from "node:test";
import { readModelCatalog, recordReportedModel, selectModelSettings } from "../src/workspace-models.ts";

const catalog = [
  { model: "gpt-6-luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  { model: "gpt-6.2-astra", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  { model: "gpt-6.2-sol", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
];

test("workload model preferences depend on catalog availability and explicit overrides", () => {
  assert.equal(selectModelSettings(catalog, undefined, "routine").requestedModel, "gpt-6-luna");
  assert.equal(selectModelSettings(catalog, undefined, "complex").requestedModel, "gpt-6.2-astra");
  assert.equal(selectModelSettings(catalog, undefined).requestedModel, undefined);
  assert.equal(selectModelSettings([], undefined, "complex").requestedModel, undefined);
  assert.equal(selectModelSettings([], "private-model", "complex").requestedModel, "private-model");
  assert.throws(() => selectModelSettings(catalog, undefined, "arbitrary"), /assignment complexity/);
});

test("selects a supported effort for the reported model and retains it on resume", () => {
  const requested = selectModelSettings(catalog, undefined, "complex");
  const observed = recordReportedModel(requested, { model: "gpt-6.2-sol", reasoningEffort: "low" }, catalog);
  assert.equal(observed.requestedModel, "gpt-6.2-astra");
  assert.equal(observed.reportedModel, "gpt-6.2-sol");
  assert.equal(observed.effort, "high");
  assert.equal(observed.reportedEffort, "low");
  assert.equal(recordReportedModel(observed, { model: "gpt-6.2-sol" }, []).effort, "high");
  const changed = recordReportedModel(observed, { model: "unknown-model" }, catalog);
  assert.equal(changed.effort, undefined);
  assert.equal(changed.reportedEffort, undefined);
});

test("catalog verifies provider scope, follows cursors, and ignores hidden models", async () => {
  const requests: string[] = [];
  const result = await readModelCatalog({
    async call<T>(method: string, params: { cursor?: string }) {
      requests.push(method);
      if (method === "config/read") return { config: { model_provider: null } } as T;
      if (!params.cursor) return { data: [catalog[0]], nextCursor: "continue" } as T;
      assert.equal(params.cursor, "continue");
      return { data: [catalog[1], { ...catalog[2], hidden: true }] } as T;
    },
  });
  assert.deepEqual(result, catalog.slice(0, 2));
  assert.deepEqual(requests, ["config/read", "model/list", "model/list"]);
  await assert.rejects(readModelCatalog({
    async call<T>(method: string) {
      assert.equal(method, "config/read");
      return { config: { model_provider: "custom" } } as T;
    },
  }), /another provider/);
});
