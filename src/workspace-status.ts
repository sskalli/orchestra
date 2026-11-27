import type { WorkspaceAgent, WorkspaceMessage } from "./workspace-runtime.ts";

export function needsUserInput(message: WorkspaceMessage) {
  return message.productQuestion?.status === "pending" ||
    message.implementationRequest?.status === "pending" ||
    message.commandApproval?.status === "pending";
}

export function effectiveAgentStatus(agent: Pick<WorkspaceAgent, "status" | "messages">) {
  return agent.messages.some(needsUserInput) ? "attention" : agent.status;
}

type TaskAgent = Pick<WorkspaceAgent, "id" | "parentId" | "archivedAt" | "status" | "messages">;

// Top-level tasks (a root and its children) with a pending request or a run that failed or needs attention.
export function attentionTaskCount(agents: TaskAgent[]) {
  const active = agents.filter((agent) => !agent.archivedAt);
  const activeIds = new Set(active.map(({ id }) => id));
  const flagged = (agent: TaskAgent) => effectiveAgentStatus(agent) === "attention" || agent.status === "error";
  return active.filter((agent) => !agent.parentId || !activeIds.has(agent.parentId)).filter((root) => {
    const ids = new Set([root.id]);
    let size = 0;
    while (size !== ids.size) {
      size = ids.size;
      for (const agent of agents) if (agent.parentId && ids.has(agent.parentId)) ids.add(agent.id);
    }
    return active.some((agent) => ids.has(agent.id) && flagged(agent));
  }).length;
}

export function documentTitle(agents: TaskAgent[]) {
  const count = attentionTaskCount(agents);
  return count ? `Orchestra (${count})` : "Orchestra";
}
