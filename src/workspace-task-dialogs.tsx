import { useEffect, useRef, useState } from "react";

type NewTaskDialogProps = {
  open: boolean;
  blocked: boolean;
  projects: readonly { id: string }[];
  onDismiss: () => void;
  onCreate: (name: string, projectIds: string[]) => Promise<void>;
};

export function NewTaskDialog({ open, blocked, projects, onDismiss, onCreate }: NewTaskDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      setName("");
      setProjectIds([]);
      setError("");
    }
  }, [open]);

  async function submit() {
    if (pending || blocked) return;
    setPending(true);
    setError("");
    try {
      await onCreate(name.trim() || "New session", projectIds);
      onDismiss();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The session could not be created.");
    } finally {
      setPending(false);
    }
  }

  return <dialog ref={dialog} className="sw-lifecycle-dialog sw-new-task" aria-labelledby="new-task-heading" onCancel={(event) => {
    if (pending) event.preventDefault();
    else onDismiss();
  }}>
    <h2 id="new-task-heading">New session</h2>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="sw-new-task-name">
        Name <input value={name} onChange={(event) => setName(event.target.value)}
          placeholder="New session" maxLength={60} disabled={pending} autoFocus />
      </label>
      <fieldset disabled={pending}>
        <legend>Repositories</legend>
        <p>Select the repositories this session may work in. Leave them unchecked for a general chat.</p>
        {projects.map(({ id }) => <label key={id}>
          <input type="checkbox" checked={projectIds.includes(id)} onChange={(event) => {
            const checked = event.target.checked;
            setProjectIds((current) => checked ? [...current, id] : current.filter((selected) => selected !== id));
          }} />
          {id}
        </label>)}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={pending} onClick={onDismiss}>Cancel</button>
        <button type="submit" disabled={pending || blocked}>{pending ? "Starting…" : "Start session"}</button>
      </footer>
    </form>
  </dialog>;
}

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
