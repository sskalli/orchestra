import type { WorkspaceAgent } from "./workspace-runtime.ts";

export function effectiveAgentStatus(agent: Pick<WorkspaceAgent, "status" | "messages">) {
  return agent.messages.some((entry) => entry.productQuestion?.status === "pending") ? "attention" : agent.status;
}
