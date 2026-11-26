export type ModelSettings = {
  requestedModel?: string;
  /** Reasoning effort the user chose for this task; the provider default applies when absent. */
  requestedEffort?: string;
  reportedModel?: string;
  reportedEffort?: string;
  source: "override" | "provider-default";
};

export type ReportedModel = { model?: string; reasoningEffort?: string | null };

/** One choice in the model picker, normalized from the provider's model list. */
export type ModelOption = {
  /** The model to request. An empty id stands for the provider's default model. */
  id: string;
  label: string;
  description?: string;
  /** Other ids that name the same model, such as the full id behind a Claude alias. */
  aliases?: string[];
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
};
export type ModelCatalog = { models: ModelOption[]; error?: string };

/** A model as listed by `model/list` in the App Server protocol; the Claude engine answers with the same shape. */
export type ProviderModel = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string }[];
  defaultReasoningEffort?: string | null;
  resolvedModel?: string;
};

export function selectModelSettings(override: string | undefined): ModelSettings {
  return { requestedModel: override || undefined, source: override ? "override" : "provider-default" };
}

export function recordReportedModel(settings: ModelSettings, response: ReportedModel): ModelSettings {
  return {
    requestedModel: settings.requestedModel,
    ...(settings.requestedEffort ? { requestedEffort: settings.requestedEffort } : {}),
    source: settings.requestedModel ? "override" : "provider-default",
    reportedModel: response.model ?? settings.reportedModel,
    reportedEffort: response.reasoningEffort ?? undefined,
  };
}

const modelChoicePattern = /^[\w.:/@[\]-]{1,200}$/;

/** Validates a picker value: a string sets it, null or "" returns to the provider default, undefined leaves it unchanged. */
export function modelChoice(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (value === "") return null;
  if (typeof value === "string" && modelChoicePattern.test(value)) return value;
  throw new Error(`Choose a valid ${label}.`);
}

/**
 * Applies the user's model or effort choice. The change takes effect from the next turn.
 * A new model clears the reported values, which described the previous model.
 */
export function chooseModelSettings(settings: ModelSettings, change: { model?: string | null; effort?: string | null }): ModelSettings {
  const next: ModelSettings = { ...settings };
  if (change.model !== undefined && change.model !== (settings.requestedModel ?? null)) {
    if (change.model === null) delete next.requestedModel;
    else next.requestedModel = change.model;
    delete next.reportedModel;
    delete next.reportedEffort;
  }
  if (change.effort !== undefined && change.effort !== (settings.requestedEffort ?? null)) {
    if (change.effort === null) delete next.requestedEffort;
    else next.requestedEffort = change.effort;
    delete next.reportedEffort;
  }
  next.source = next.requestedModel ? "override" : "provider-default";
  return next;
}

/** The model and effort to send with a turn; null keeps the provider's default choice. */
export function turnModelParams(settings: ModelSettings | undefined) {
  return { model: settings?.requestedModel ?? null, effort: settings?.requestedEffort ?? null };
}

export function modelOptions(models: ProviderModel[]): ModelOption[] {
  const options: ModelOption[] = [];
  for (const entry of models) {
    const id = typeof entry.model === "string" ? entry.model : typeof entry.id === "string" ? entry.id : undefined;
    if (id === undefined || entry.hidden || options.some((option) => option.id === id)) continue;
    const efforts = (entry.supportedReasoningEfforts ?? [])
      .map((effort) => effort?.reasoningEffort)
      .filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
    const aliases = [entry.id, entry.resolvedModel]
      .filter((alias): alias is string => typeof alias === "string" && alias.length > 0 && alias !== id);
    options.push({
      id,
      label: entry.displayName || id || "Default",
      ...(entry.description ? { description: entry.description } : {}),
      ...(aliases.length ? { aliases: [...new Set(aliases)] } : {}),
      efforts,
      ...(entry.defaultReasoningEffort ? { defaultEffort: entry.defaultReasoningEffort } : {}),
      ...(entry.isDefault ? { isDefault: true } : {}),
    });
  }
  return options;
}

/** Resolves what the picker shows for a task: the chosen model, else the reported one, else the provider default. */
export function currentModelChoice(settings: ModelSettings | undefined, models: ModelOption[]) {
  const modelId = settings?.requestedModel ?? settings?.reportedModel;
  const option = modelId
    ? models.find((entry) => entry.id === modelId || entry.aliases?.includes(modelId))
    : models.find((entry) => entry.isDefault);
  const effort = settings?.requestedEffort ?? settings?.reportedEffort ?? option?.defaultEffort;
  return { modelId, option, effort };
}
