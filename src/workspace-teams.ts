export type TeamHandoff = {
  summary?: string;
  decisions?: string[];
  paths?: string[];
  sourceRevisions?: { projectId: string; revision: string }[];
};

export type WorkspaceTeam = {
  id: string;
  name: string;
  scope: string;
  projectIds: string[];
  archivedAt?: number;
  handoff?: TeamHandoff;
};

const summaryLimit = 1800;
const decisionLimit = 240;
const pathLimit = 240;
const maxDecisions = 6;
const maxPaths = 12;
const maxRevisions = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= limit;
}

function isProjectPath(value: unknown): value is string {
  return isText(value, pathLimit) && !/[\\\x00-\x1f]/.test(value) && !/^[a-zA-Z]:/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

function isRevision(value: unknown): value is NonNullable<TeamHandoff["sourceRevisions"]>[number] {
  return isRecord(value) && isText(value.projectId, 512) && typeof value.revision === "string" &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.revision);
}

export function boundedTeamHandoff(input: TeamHandoff): TeamHandoff {
  const summary = input.summary?.trim().slice(0, summaryLimit).trimEnd();
  const decisions = [...new Set((input.decisions ?? []).map((value) => value.trim().slice(0, decisionLimit).trimEnd()).filter(Boolean))].slice(0, maxDecisions);
  const paths = [...new Set((input.paths ?? []).filter(isProjectPath))].slice(0, maxPaths);
  const revisions = new Map<string, NonNullable<TeamHandoff["sourceRevisions"]>[number]>();
  for (const value of input.sourceRevisions ?? []) {
    if (isRevision(value)) revisions.set(value.projectId, { projectId: value.projectId, revision: value.revision });
  }
  const sourceRevisions = [...revisions.values()].slice(0, maxRevisions);
  return {
    ...(summary && { summary }),
    ...(decisions.length && { decisions }),
    ...(paths.length && { paths }),
    ...(sourceRevisions.length && { sourceRevisions }),
  };
}

function validList<T>(value: unknown, limit: number, test: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.length <= limit && value.every(test);
}

function isHandoff(value: unknown, projectIds: string[]): value is TeamHandoff {
  return isRecord(value) &&
    (value.summary === undefined || isText(value.summary, summaryLimit)) &&
    (value.decisions === undefined || validList(value.decisions, maxDecisions, (entry): entry is string => isText(entry, decisionLimit))) &&
    (value.paths === undefined || validList(value.paths, maxPaths, isProjectPath)) &&
    (value.sourceRevisions === undefined || (validList(value.sourceRevisions, maxRevisions, isRevision) &&
      value.sourceRevisions.every(({ projectId }) => projectIds.includes(projectId))));
}

export function isWorkspaceTeam(value: unknown): value is WorkspaceTeam {
  if (!isRecord(value) || !isText(value.id, 512) || !isText(value.name, 240) || !isText(value.scope, 24_000) ||
      !Array.isArray(value.projectIds) || !value.projectIds.length ||
      !value.projectIds.every((id): id is string => isText(id, 512)) || new Set(value.projectIds).size !== value.projectIds.length) return false;
  return (value.archivedAt === undefined || (typeof value.archivedAt === "number" && Number.isSafeInteger(value.archivedAt) && value.archivedAt > 0)) &&
    (value.handoff === undefined || isHandoff(value.handoff, value.projectIds));
}

export function resolveTeamReuseRequest(text: string, teams: WorkspaceTeam[]) {
  const commands = /(?:^|[.!?\n]\s*)(?:(?:(?:can|could|would|will)\s+you|i(?:['’]d|\s+would)\s+like\s+you\s+to|let['’]s)\s+)?(?:please\s+)?(use|reuse|reactivate)\s+(?:the\s+)?/gi;
  const suffix = /\s+(?:team|squad)$/i;
  const exact = (label: string) => {
    const normalized = label.toLowerCase();
    const id = teams.find((team) => team.id.toLowerCase() === normalized);
    return id ? [id] : teams.filter((team) => team.name.toLowerCase() === normalized);
  };
  const source = text.trim();
  for (const command of source.matchAll(commands)) {
    const phrase = source.slice(command.index + command[0].length).split("\n", 1)[0];
    const marker = /^(?:archived\s+)?(?:team|squad)\s+/i.exec(phrase)?.[0];
    const target = marker ? phrase.slice(marker.length) : phrase;
    const quoted = /^(?:"([^"]+)"|“([^”]+)”)/.exec(target);
    const labels = quoted ? [quoted[1] ?? quoted[2]] : [
      ...[...target.matchAll(/\s+(?:to|for)\s+|[:,]/gi)].map((delimiter) => target.slice(0, delimiter.index)),
      target,
    ].map((label) => label.trim().replace(/[.!?,]+$/, ""));
    const matchesFor = (label: string) => {
      const full = exact(label);
      const alias = !quoted && suffix.test(label) && !full.length ? exact(label.replace(suffix, "")) : [];
      // An unquoted leading "team" may belong to the name instead of introducing it.
      const literal = marker && !quoted ? exact(marker + label) : [];
      return [...new Set([...full, ...alias, ...literal])];
    };
    // A delimiter word can itself be part of the name. Prefer the longest complete match.
    const matchingLabel = labels.findLast((label) => matchesFor(label).length);
    const reference = matchingLabel ?? labels[0];
    if (!marker && !(!quoted && suffix.test(reference)) && (command[1].toLowerCase() === "use" || !matchingLabel)) continue;
    return { reference, teamIds: matchesFor(reference).filter((team) => team.archivedAt).map((team) => team.id) };
  }
}
