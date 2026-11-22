const roles = {
  lead: { label: "Lead", color: "lead" },
  coder: { label: "Coder", color: "coder" },
  reviewer: { label: "Reviewer", color: "reviewer" },
  tester: { label: "Tester", color: "tester" },
  designer: { label: "Designer", color: "designer" },
  analyser: { label: "Researcher", color: "researcher" },
  pm: { label: "Product adviser", color: "other" },
} as const;

export function agentAppearance({ name, duty }: { name: string; duty?: string }) {
  const role = duty && Object.hasOwn(roles, duty) ? roles[duty as keyof typeof roles] : undefined;
  return { displayName: name, color: role?.color ?? "other", roleLabel: role?.label };
}
