// Dropping files on a composer: each file is uploaded to the local server and its stored path is inserted at the caret.
import { useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";
import { applyTextEdit } from "./workspace-composer.tsx";

/** Mirrors attachmentLimits in workspace-attachments.ts, so oversized drops fail before uploading. */
const maxFiles = 10;
const maxFileBytes = 25 * 1024 * 1024;

const hasFiles = (event: { dataTransfer: DataTransfer | null }) => Boolean(event.dataTransfer?.types.includes("Files"));

// A file dropped anywhere else would make the browser open it in place of the workspace.
if (typeof window !== "undefined") {
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer && !(event.target instanceof Element && event.target.closest("[data-file-drop]"))) {
      event.dataTransfer.dropEffect = "none";
    }
  });
  window.addEventListener("drop", (event) => { if (hasFiles(event)) event.preventDefault(); });
}

async function upload(file: File) {
  const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const body = await response.json().catch(() => ({})) as { path?: string; error?: string };
  if (!response.ok || typeof body.path !== "string") throw new Error(body.error ?? `${file.name} could not be attached.`);
  return body.path;
}

/** Wraps a path in inline code, with a longer fence when the path itself contains backticks. */
function pathReference(path: string) {
  const fence = "`".repeat(Math.max(0, ...[...path.matchAll(/`+/g)].map(([run]) => run.length)) + 1);
  return fence.length > 1 ? `${fence} ${path} ${fence}` : `${fence}${path}${fence}`;
}

/**
 * Lets a textarea's surrounding element accept dropped files. Spread `dropProps` on the drop target and style it
 * with `data-dropping`. Errors go to `onError`; an empty string clears a previous drop error.
 */
export function useFileDrop({ textarea, disabled, onError }: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const depth = useRef(0);

  async function attach(files: File[]) {
    if (files.length > maxFiles) {
      onError(`Drop at most ${maxFiles} files at a time.`);
      return;
    }
    const tooLarge = files.find((file) => file.size > maxFileBytes);
    if (tooLarge) {
      onError(`${tooLarge.name} is larger than ${maxFileBytes / 1024 / 1024} MB.`);
      return;
    }
    onError("");
    setUploading((count) => count + files.length);
    const paths: string[] = [];
    try {
      for (const file of files) {
        paths.push(await upload(file));
        setUploading((count) => count - 1);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "The files could not be attached.");
    } finally {
      setUploading((count) => Math.max(0, count - (files.length - paths.length)));
    }
    const element = textarea.current;
    if (!paths.length || !element || element.disabled) return;
    const start = element.selectionStart;
    const before = element.value.slice(0, start);
    const after = element.value.slice(element.selectionEnd);
    const text = (before && !/\s$/.test(before) ? "\n" : "") + paths.map(pathReference).join("\n") +
      (after && !/^\s/.test(after) ? "\n" : "");
    const end = start + text.length;
    applyTextEdit(element, { start, end: element.selectionEnd, text, selectionStart: end, selectionEnd: end });
  }

  const active = !disabled;
  const dropProps = {
    "data-file-drop": active ? "" : undefined,
    "data-dropping": dragging || undefined,
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!active || !hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!active || !hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!active || !hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      depth.current = 0;
      setDragging(false);
      if (!active || !hasFiles(event)) return;
      event.preventDefault();
      void attach([...event.dataTransfer.files]);
    },
  };

  return { dropProps, uploading };
}
