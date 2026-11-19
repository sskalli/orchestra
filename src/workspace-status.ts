import type { AgentStatus } from "./workspace-runtime.ts";

type StatusAgent = { status: AgentStatus; check?: { outcome: string } };

// A finished provider turn is not necessarily a successful validation.
// Also correct older saved snapshots that recorded blocked checks as done.
export function effectiveAgentStatus(agent: StatusAgent): AgentStatus {
  if (agent.status === "done") {
    if (agent.check?.outcome === "blocked") return "attention";
    if (agent.check?.outcome === "changes-requested") return "error";
  }
  return agent.status;
}
