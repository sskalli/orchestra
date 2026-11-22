import { useEffect, useRef, useState } from "react";

type LifecycleAction = "archive" | "restore" | "delete";

type TaskLifecycleDialogProps = {
  action: LifecycleAction | undefined;
  agentName: string | undefined;
  affectedCount: number;
  hasRunning: boolean;
  connected: boolean;
  onDismiss: () => void;
  onConfirm: () => Promise<void>;
};

export function TaskLifecycleDialog({ action, agentName, affectedCount, hasRunning, connected, onDismiss, onConfirm }: TaskLifecycleDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (action) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      setError("");
    }
  }, [action]);

  async function confirm() {
    if (!action || pending) return;
    setPending(true);
    setError("");
    try {
      await onConfirm();
      onDismiss();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return <dialog ref={dialog} className="sw-lifecycle-dialog" aria-labelledby="lifecycle-heading" onCancel={(event) => {
    if (pending) event.preventDefault();
    else onDismiss();
  }}>
    <h2 id="lifecycle-heading">{action === "delete" ? "Delete permanently?" : action === "restore" ? "Restore agents?" : hasRunning ? "Stop and archive?" : "Archive agents?"}</h2>
    <p>{agentName}</p>
    <p>{affectedCount} agent{affectedCount === 1 ? "" : "s"} in the selected subtree, including all descendants.</p>
    {action === "delete" ? <p>Their Orchestra records, conversations, and reports will be permanently removed. Project files, branches, and worktrees stay on disk.</p>
      : action === "restore" ? <p>Return this subtree to the active map. Any archived ancestors it needs will also be restored. Queued work stays paused.</p>
      : <p>{hasRunning ? "Running work must stop before these agents are hidden. " : ""}Conversations and reports remain available in Archived.</p>}
    {error && <p role="alert">{error}</p>}
    <footer>
      <button type="button" autoFocus disabled={pending} onClick={onDismiss}>Cancel</button>
      <button type="button" disabled={!connected || pending || agentName === undefined} onClick={() => void confirm()}>
        {pending ? "Please wait…" : action === "delete" ? "Delete permanently" : action === "restore" ? "Restore" : hasRunning ? "Stop and archive" : "Archive"}
      </button>
    </footer>
  </dialog>;
}
