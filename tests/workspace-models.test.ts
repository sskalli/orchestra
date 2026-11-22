import assert from "node:assert/strict";
import { test } from "node:test";
import { recordReportedModel, selectModelSettings } from "../src/workspace-models.ts";

test("direct tasks use the provider default or an explicit model override", () => {
  assert.deepEqual(selectModelSettings(undefined), { requestedModel: undefined, source: "provider-default" });
  assert.deepEqual(selectModelSettings("custom-model"), { requestedModel: "custom-model", source: "override" });
});

test("reported settings distinguish the provider model from the requested override", () => {
  const settings = recordReportedModel(selectModelSettings("custom-model"), {
    model: "provider-model", reasoningEffort: "medium",
  });
  assert.deepEqual(settings, {
    requestedModel: "custom-model", source: "override", reportedModel: "provider-model", reportedEffort: "medium",
  });
  assert.equal(recordReportedModel(settings, {}).reportedModel, "provider-model");
});
