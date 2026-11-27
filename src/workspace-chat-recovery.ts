import type { WorkspaceMessage } from "./workspace-runtime.ts";

/**
 * Codex App Server rejects turn input longer than this many Unicode characters
 * ("Input exceeds the maximum length of 1048576 characters."). The Claude engine
 * speaks the same protocol, so Orchestra applies one limit to every engine.
 */
export const messageCharacterLimit = 1_048_576;

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
 * questions have their own flow, so they are not offered.
 */
export function retryableMessageId(messages: readonly WorkspaceMessage[]) {
  // With queued follow-ups the runtime already put the failed text back at the head of the paused queue.
  if (messages.some(({ role, state }) => role === "user" && state === "queued")) return undefined;
  const latest = messages.findLast((entry) => entry.role === "user" && entry.state !== "queued");
  if (!latest || latest.state !== "failed" || latest.answersProductQuestionId || !latest.text.trim()) return undefined;
  return latest.id;
}

export type SendOutcome = { sent: true } | { sent: false; error?: unknown; restore: string[] };

/**
 * Runs a chat's sends one at a time in submission order. When one fails, the sends
 * submitted after it are cancelled before they run, and the failed send's outcome
 * lists every unsent text in order so the composer can put them back together.
 */
export class OrderedSends {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending: { text: string; cancelled: boolean }[] = [];

  run(text: string, send: (text: string) => Promise<void> | void): Promise<SendOutcome> {
    const entry = { text, cancelled: false };
    this.pending.push(entry);
    const outcome = this.chain.then(async (): Promise<SendOutcome> => {
      try {
        if (entry.cancelled) return { sent: false, restore: [] };
        await send(text);
        return { sent: true };
      } catch (error) {
        const later = this.pending.slice(this.pending.indexOf(entry) + 1);
        for (const next of later) next.cancelled = true;
        return { sent: false, error, restore: [text, ...later.map((next) => next.text)] };
      } finally {
        this.pending.splice(this.pending.indexOf(entry), 1);
      }
    });
    this.chain = outcome;
    return outcome;
  }
}

/** Puts unsent texts back ahead of anything typed since, in their original order. */
export function restoredDraft(unsent: readonly string[], typed: string) {
  return [...unsent, ...(typed.trim() ? [typed] : [])].join("\n");
}
