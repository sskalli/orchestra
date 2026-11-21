import type { AgentStatus, WorkspaceAgent } from "./workspace-runtime.ts";

type StatusAgent = Pick<WorkspaceAgent, "status" | "implementationProposal"> & { check?: { outcome: string } };

const implementationStatuses = {
  "awaiting-approval": "attention",
  implementing: "working",
  blocked: "error",
  "ready-for-review": "awaiting-confirmation",
  confirmed: "done",
} as const;

// A finished provider turn is not necessarily a successful validation.
// Also correct older saved snapshots that recorded blocked checks as done.
export function effectiveAgentStatus(agent: StatusAgent): AgentStatus {
  if (agent.implementationProposal) return implementationStatuses[agent.implementationProposal.status];
  if (agent.status === "done") {
    if (agent.check?.outcome === "blocked") return "attention";
    if (agent.check?.outcome === "changes-requested") return "error";
  }
  return agent.status;
}
