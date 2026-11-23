import type { WorkspaceCommand } from "./workspace-runtime.ts";

export class UnknownCommandOutcome extends Error {
  constructor() {
    super("Orchestra could not confirm whether the command was accepted.");
  }
}

async function sendRequest(command: WorkspaceCommand) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }).catch(() => { throw new UnknownCommandOutcome(); });

  if (response.status >= 500) throw new UnknownCommandOutcome();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "The workspace could not accept that command");
  }
  return response;
}

export async function send(command: WorkspaceCommand) {
  await sendRequest(command);
}

export async function createTask(name: string, projectIds: string[]) {
  const response = await sendRequest({ type: "createTask", name, projectIds });
  const result = await response.json().catch(() => { throw new UnknownCommandOutcome(); });
  if (typeof result?.agentId !== "string") throw new UnknownCommandOutcome();
  return result.agentId as string;
}
