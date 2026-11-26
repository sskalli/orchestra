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

test("model choices apply to later turns and clear what the provider reported for the previous model", async () => {
  const { chooseModelSettings, modelChoice, turnModelParams } = await import("../src/workspace-models.ts");
  const reported = { requestedModel: "a", reportedModel: "a-2025", reportedEffort: "medium", source: "override" as const };
  assert.deepEqual(chooseModelSettings(reported, { effort: "high" }),
    { requestedModel: "a", reportedModel: "a-2025", requestedEffort: "high", source: "override" });
  assert.deepEqual(chooseModelSettings(reported, { model: "b" }), { requestedModel: "b", source: "override" });
  assert.deepEqual(chooseModelSettings(reported, { model: "a" }), reported, "choosing the same model keeps the reported values");
  assert.deepEqual(chooseModelSettings({ requestedModel: "b", requestedEffort: "high", source: "override" }, { model: null, effort: null }),
    { source: "provider-default" });
  assert.deepEqual(turnModelParams(undefined), { model: null, effort: null });
  assert.deepEqual(turnModelParams({ requestedModel: "b", requestedEffort: "low", source: "override" }), { model: "b", effort: "low" });
  assert.deepEqual(recordReportedModel({ requestedEffort: "low", source: "provider-default" }, { model: "p", reasoningEffort: "high" }),
    { requestedModel: undefined, requestedEffort: "low", source: "provider-default", reportedModel: "p", reportedEffort: "high" });
  assert.equal(modelChoice(undefined, "model"), undefined);
  assert.equal(modelChoice("", "model"), null);
  assert.equal(modelChoice("claude-opus-5-5[1m]", "model"), "claude-opus-5-5[1m]");
  assert.throws(() => modelChoice("two words", "model"), /valid model/);
  assert.throws(() => modelChoice(5, "reasoning effort"), /valid reasoning effort/);
});

test("provider model lists become picker options, and the current choice resolves through aliases", async () => {
  const { currentModelChoice, modelOptions } = await import("../src/workspace-models.ts");
  const options = modelOptions([
    { id: "default", model: "", displayName: "Default (recommended)", isDefault: true, resolvedModel: "claude-opus-5-5",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "max" }] },
    { id: "opus", model: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5", supportedReasoningEfforts: [] },
    { id: "hidden", model: "hidden", hidden: true },
    { id: "opus", model: "opus", displayName: "Duplicate" },
  ]);
  assert.deepEqual(options, [
    { id: "", label: "Default (recommended)", aliases: ["default", "claude-opus-5-5"], efforts: ["low", "max"], isDefault: true },
    { id: "opus", label: "Opus", aliases: ["claude-opus-5-5"], efforts: [] },
  ]);
  assert.equal(currentModelChoice(undefined, options).option, options[0]);
  assert.equal(currentModelChoice({ requestedModel: "opus", source: "override" }, options).option, options[1]);
  assert.deepEqual(currentModelChoice({ reportedModel: "custom", reportedEffort: "high", source: "provider-default" }, options),
    { modelId: "custom", option: undefined, effort: "high" });
  assert.equal(currentModelChoice(undefined, [{ id: "m", label: "M", efforts: ["low"], defaultEffort: "low", isDefault: true }]).effort, "low");
});
