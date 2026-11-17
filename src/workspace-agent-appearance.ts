type AgentIdentity = { id?: string; parentId?: string; name: string; role: string; duty?: string; roleNumber?: number };

function roleSlug({ role, duty }: AgentIdentity) {
  if (role === "coordinator") return "pilot";
  if (role === "lead") return "lead";
  if (duty === "analyser") return "researcher";
  if (duty === "pm") return "product-adviser";
  return duty ?? "agent";
}

export function numberAgentRoles<T extends AgentIdentity>(agents: readonly T[]) {
  const counts = new Map<string, number>();
  const byId = new Map(agents.filter((agent) => agent.id).map((agent) => [agent.id!, agent]));
  function teamId(agent: T) {
    let current = agent;
    const visited = new Set<string>();
    while (current.role !== "lead" && current.parentId && !visited.has(current.parentId)) {
      visited.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.role === "lead" ? current.id ?? current.name : "project";
  }
  return agents.map((agent) => {
    const role = roleSlug(agent);
    const key = agent.role === "lead" ? role : `${teamId(agent)}:${role}`;
    const roleNumber = (counts.get(key) ?? 0) + 1;
    counts.set(key, roleNumber);
    return { ...agent, roleNumber };
  });
}

const roleWords: Record<string, string> = {
  lead: "team-lead|lead",
  pilot: "pilot|coordinator",
  reviewer: "reviewer|review",
  tester: "tester|tests|test",
  designer: "designer|design",
  researcher: "researcher|analyser|analyzer",
  "product-adviser": "product-adviser|pm",
  agent: "agent|worker",
};

export function agentAppearance(agent: AgentIdentity) {
  const role = roleSlug(agent);
  const color = role === "lead" || role === "coder" || role === "reviewer" || role === "tester" || role === "designer" ? role : "other";
  const alias = (roleWords[role] ?? role).replaceAll("-", "[-\\s]+");
  const separator = "[\\s:_|–—-]+";
  const topic = agent.name.toLowerCase().trim()
    .replace(new RegExp(`^(?:${alias})(?:-\\d+)?(?:${separator}|$)`), "")
    .replace(new RegExp(`(?:^${alias}$|${separator}(?:${alias})$)`), "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const prefix = `${role}-${agent.roleNumber ?? 1}`;
  return { color, displayName: topic ? `${prefix} | ${topic}` : prefix };
}
