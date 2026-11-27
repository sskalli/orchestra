import type { WorkspaceAgent, WorkspaceMessage } from "./workspace-runtime.ts";

export function needsUserInput(message: WorkspaceMessage) {
  return message.productQuestion?.status === "pending" ||
    message.implementationRequest?.status === "pending" ||
    message.commandApproval?.status === "pending";
}

export function effectiveAgentStatus(agent: Pick<WorkspaceAgent, "status" | "messages">) {
  return agent.messages.some(needsUserInput) ? "attention" : agent.status;
}

/** The tab title shows how many tasks have failures or requests the user has not seen in the Inbox or their chat. */
export function documentTitle(unseenAlerts: number) {
  return unseenAlerts ? `Orchestra (${unseenAlerts})` : "Orchestra";
}
