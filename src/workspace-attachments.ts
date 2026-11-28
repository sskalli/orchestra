import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

/** Limits for files dropped into a composer. The browser checks them first; the server enforces them. */
export const attachmentLimits = { maxFiles: 10, maxFileBytes: 25 * 1024 * 1024 } as const;

const maxNameLength = 120;

/**
 * Turns a dropped file's name into a safe single path segment: no directories, no control or reserved characters,
 * no leading dots (so it is neither hidden nor "." or ".."), and a bounded length that keeps the extension.
 */
export function sanitizeAttachmentName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  let clean = base.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (clean.length > maxNameLength) {
    const dot = clean.lastIndexOf(".");
    const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    clean = clean.slice(0, maxNameLength - extension.length).trimEnd() + extension;
  }
  return clean || "file";
}

export class AttachmentTooLarge extends Error {
  constructor() {
    super(`Files can be at most ${attachmentLimits.maxFileBytes / 1024 / 1024} MB.`);
  }
}

/** Reads a request body up to the file limit; a larger body is refused without buffering it all. */
export async function readAttachmentBody(request: IncomingMessage) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > attachmentLimits.maxFileBytes) throw new AttachmentTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= attachmentLimits.maxFileBytes) chunks.push(chunk);
      else {
        // Stop reading without destroying the socket, so the 413 response can still be written.
        request.off("data", onData);
        request.pause();
        resolve();
      }
    };
    request.on("data", onData);
    request.once("end", () => resolve());
    request.once("error", reject);
  });
  if (size > attachmentLimits.maxFileBytes) throw new AttachmentTooLarge();
  return Buffer.concat(chunks);
}

/**
 * Stores a dropped file in its own folder under the attachments root, so names never collide, and returns its
 * absolute path for the message. Files are private to the local account and are never served back.
 */
export async function saveAttachment(root: string, name: string, body: Buffer) {
  const folder = join(root, randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, sanitizeAttachmentName(name));
  try {
    await writeFile(path, body, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  return path;
}
