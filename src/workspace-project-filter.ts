/** Which projects the map shows: every task ("workspace"), or only tasks linked to the listed projects. */
export type ProjectFilter = { mode: "workspace" } | { mode: "projects"; projectIds: string[] };

type FilterableAgent = { id: string; parentId?: string; projectId?: string; directTask?: { projectIds: string[] } };

export const workspaceFilter: ProjectFilter = { mode: "workspace" };

/** The repositories a task works in. Subagents carry the project their parent assigned them. */
export function agentProjectIds(agent: FilterableAgent): string[] {
  return agent.directTask ? agent.directTask.projectIds : agent.projectId ? [agent.projectId] : [];
}

/**
 * Reads a saved filter against the current projects: unknown ids are dropped, and selecting every project
 * is the same as the whole workspace.
 */
export function normalizeProjectFilter(value: unknown, projectIds: readonly string[]): ProjectFilter {
  if (!value || typeof value !== "object" || (value as ProjectFilter).mode !== "projects") return workspaceFilter;
  const saved = (value as { projectIds?: unknown }).projectIds;
  if (!Array.isArray(saved)) return workspaceFilter;
  const selected = projectIds.filter((id) => saved.includes(id));
  return selected.length === projectIds.length ? workspaceFilter : { mode: "projects", projectIds: selected };
}

/** Checks or unchecks one project. */
export function toggleProject(filter: ProjectFilter, projectId: string, checked: boolean, projectIds: readonly string[]): ProjectFilter {
  const current = filter.mode === "workspace" ? projectIds : filter.projectIds;
  const next = checked ? [...current, projectId] : current.filter((id) => id !== projectId);
  return normalizeProjectFilter({ mode: "projects", projectIds: next }, projectIds);
}

export function isProjectChecked(filter: ProjectFilter, projectId: string) {
  return filter.mode === "workspace" || filter.projectIds.includes(projectId);
}

/**
 * Keeps each top-level task, with all its subagents, when the task or any of its subagents works in a checked
 * project. A task whose parent is not in the list counts as top-level.
 */
export function filterAgentsByProject<T extends FilterableAgent>(agents: readonly T[], filter: ProjectFilter): T[] {
  if (filter.mode === "workspace") return [...agents];
  const checked = new Set(filter.projectIds);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const rootOf = (agent: T) => {
    let root = agent;
    const visited = new Set([root.id]);
    while (root.parentId && byId.has(root.parentId) && !visited.has(root.parentId)) {
      root = byId.get(root.parentId)!;
      visited.add(root.id);
    }
    return root.id;
  };
  const visibleRoots = new Set(agents.filter((agent) => agentProjectIds(agent).some((id) => checked.has(id))).map(rootOf));
  return agents.filter((agent) => visibleRoots.has(rootOf(agent)));
}

export function projectFilterLabel(filter: ProjectFilter, workspaceName: string) {
  if (filter.mode === "workspace") return workspaceName;
  if (!filter.projectIds.length) return "No projects";
  return filter.projectIds.length === 1 ? filter.projectIds[0] : `${filter.projectIds.length} projects`;
}
