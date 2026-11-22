export type ModelSettings = {
  requestedModel?: string;
  reportedModel?: string;
  reportedEffort?: string;
  source: "override" | "provider-default";
};

export type ReportedModel = { model?: string; reasoningEffort?: string | null };

export function selectModelSettings(override: string | undefined): ModelSettings {
  return { requestedModel: override || undefined, source: override ? "override" : "provider-default" };
}

export function recordReportedModel(settings: ModelSettings, response: ReportedModel): ModelSettings {
  return {
    requestedModel: settings.requestedModel,
    source: settings.requestedModel ? "override" : "provider-default",
    reportedModel: response.model ?? settings.reportedModel,
    reportedEffort: response.reasoningEffort ?? undefined,
  };
}
