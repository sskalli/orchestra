import type { WorkspaceMessage } from "./workspace-runtime.ts";

/**
 * Codex App Server rejects turn input longer than this many Unicode characters
 * ("Input exceeds the maximum length of 1048576 characters."). The Claude engine
 * speaks the same protocol, so Orchestra applies one limit to every engine.
 */
export const messageCharacterLimit = 1_048_576;

/** The user message Orchestra records when the user allows edits. */
export const implementationApprovalText = "I approve the requested implementation.";

/** Counts Unicode characters the way Codex does, so an astral character counts once. */
export function messageLength(text: string) {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

/**
 * Explains why a message cannot be sent, or returns undefined when it can.
 * `reserved` counts the characters Orchestra adds around the message in the same turn input.
 */
export function messageLengthProblem(text: string, reserved = 0) {
  const limit = Math.max(0, messageCharacterLimit - reserved);
  if (text.length <= limit) return undefined;
  const length = messageLength(text);
  if (length <= limit) return undefined;
  const format = (value: number) => value.toLocaleString("en-US");
  return `Message is too long (${format(length)} characters, limit ${format(limit)}). ` +
    "Shorten it, or save the content to a file in the repository and refer to that file.";
}

/**
 * The latest user message can be resent when its turn failed and nothing is queued behind it. Answers to product
 * questions and edit approvals have their own flows, so they are not offered.
 */
export function retryableMessageId(messages: readonly WorkspaceMessage[]) {
  // With queued follow-ups the runtime already put the failed text back at the head of the paused queue.
  if (messages.some(({ role, state }) => role === "user" && state === "queued")) return undefined;
  const latest = messages.findLast((entry) => entry.role === "user" && entry.state !== "queued");
  if (!latest || latest.state !== "failed" || latest.answersProductQuestionId || !latest.text.trim()) return undefined;
  if (latest.text === implementationApprovalText &&
      messages.some(({ implementationRequest }) => implementationRequest?.status === "approved")) return undefined;
  return latest.id;
}
