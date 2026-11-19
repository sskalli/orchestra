import type { AppServer } from "./app-server.ts";

type CatalogModel = {
  model: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
};

export type ModelSettings = {
  requestedModel?: string;
  reportedModel?: string;
  effort?: string;
  reportedEffort?: string;
  complexity?: "routine" | "complex";
  source: "override" | "routine" | "complex" | "provider-default";
};

export type ReportedModel = { model?: string; reasoningEffort?: string | null };

export async function readModelCatalog(server: Pick<AppServer, "call">): Promise<CatalogModel[]> {
  // Older App Server versions only expose the startup provider's catalog.
  const { config } = await server.call<{ config: { model_provider?: string | null } }>(
    "config/read", { includeLayers: false }, 3_000);
  if (config.model_provider && config.model_provider !== "openai") {
    throw new Error("The default App Server catalog belongs to another provider.");
  }
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await server.call<{ data: CatalogModel[]; nextCursor?: string | null }>("model/list", { cursor, limit: 100 }, 3_000);
    models.push(...page.data.filter((entry) => !entry.hidden));
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Codex repeated the model catalog cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

export function selectModelSettings(catalog: CatalogModel[], override: string | undefined, complexity?: unknown): ModelSettings {
  if (complexity !== undefined && complexity !== "routine" && complexity !== "complex") {
    throw new Error("Choose routine or complex for assignment complexity.");
  }
  // Prefer the documented model for each workload when this client lists it.
  const preferredModels = complexity === "routine" ? ["gpt-6-luna"]
    : complexity === "complex" ? ["gpt-6.2-astra", "gpt-6-astra"] : [];
  const preferred = preferredModels.find((model) => catalog.some((entry) => entry.model === model));
  return {
    requestedModel: override || preferred,
    complexity,
    source: override ? "override" : preferred && complexity ? complexity : "provider-default",
  };
}

function effortFor(model: CatalogModel | undefined, complexity: ModelSettings["complexity"]) {
  if (!model || !complexity) return undefined;
  const preferredEfforts = complexity === "routine" ? ["low"] : ["high", "medium"];
  return preferredEfforts.find((choice) =>
    model.supportedReasoningEfforts?.some((option) => option.reasoningEffort === choice)) ?? model.defaultReasoningEffort;
}

export function recordReportedModel(settings: ModelSettings, response: ReportedModel, catalog: CatalogModel[]): ModelSettings {
  const model = response.model ?? settings.reportedModel ?? settings.requestedModel;
  const modelChanged = response.model && response.model !== settings.reportedModel;
  const effort = modelChanged || !settings.reportedModel
    ? effortFor(catalog.find((entry) => entry.model === model), settings.complexity)
    : settings.effort;
  return {
    ...settings,
    reportedModel: response.model ?? settings.reportedModel,
    reportedEffort: response.reasoningEffort ?? undefined,
    effort,
  };
}
