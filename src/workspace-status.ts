import type { WorkspaceAgent, WorkspaceMessage } from "./workspace-runtime.ts";

export function needsUserInput(message: WorkspaceMessage) {
  return message.productQuestion?.status === "pending" || message.implementationRequest?.status === "pending";
}

export function effectiveAgentStatus(agent: Pick<WorkspaceAgent, "status" | "messages">) {
  return agent.messages.some(needsUserInput) ? "attention" : agent.status;
}
