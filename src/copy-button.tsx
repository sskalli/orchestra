import { useEffect, useRef, useState } from "react";
import { LuCheck, LuCopy } from "react-icons/lu";

type CopyStatus = "copied" | "failed";

/**
 * The chat's copy shortcut: an icon button that swaps to a check for two seconds after copying,
 * with a status region that announces the result. Styled by `.chat-icon-button` and `.chat-copy-*` in workspace-markdown.css.
 */
export function CopyButton({ text, label, className }: {
  /** The text to copy, or a function that returns it when clicked. */
  text: string | (() => string);
  /** Accessible name and tooltip while idle, such as "Copy message". */
  label: string;
  className?: string;
}) {
  const [status, setStatus] = useState<CopyStatus>();
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setStatus(undefined), 2000);
  }

  const current = status === "copied" ? "Copied" : status === "failed" ? "Could not copy" : label;
  return <>
    <button type="button" className={className ? `chat-icon-button ${className}` : "chat-icon-button"} aria-label={current}
      title={current} data-copy-status={status} onClick={() => void copy()}>
      {status === "copied" ? <LuCheck aria-hidden="true" /> : <LuCopy aria-hidden="true" />}
    </button>
    <span role="status" className={status === "failed" ? "chat-copy-failure" : "chat-copy-announcement"}>
      {status === "failed" ? "Could not copy" : status === "copied" ? "Copied" : ""}
    </span>
  </>;
}
