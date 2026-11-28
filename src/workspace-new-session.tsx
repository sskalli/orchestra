import { useEffect, useRef, useState } from "react";
import { UnknownCommandOutcome } from "./workspace-commands.ts";
import { messageLengthProblem } from "./workspace-chat-recovery.ts";
import { useComposerAssist } from "./workspace-composer.tsx";
import { useFileDrop } from "./workspace-file-drop.tsx";
import { ModelPicker } from "./workspace-model-picker.tsx";
import type { ModelChange } from "./workspace-model-picker.tsx";
import { chooseModelSettings } from "./workspace-models.ts";
import "./workspace-new-session.css";

type NewSessionComposerProps = {
  open: boolean;
  blocked: boolean;
  projects: readonly { id: string }[];
  onCancel: () => void;
  onCreate: (name: string, projectIds: string[], choice: ModelChange) => Promise<string>;
  onSend: (agentId: string, text: string) => Promise<void>;
  onStarted: (agentId: string) => void;
};

export function NewSessionComposer({ open, blocked, projects, onCancel, onCreate, onSend, onStarted }: NewSessionComposerProps) {
  const prompt = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [modelChoice, setModelChoice] = useState<ModelChange>({});
  const [createdId, setCreatedId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const assist = useComposerAssist({ textarea: prompt, anchor: prompt, value: text, projectIds, disabled: pending || !open });
  const drop = useFileDrop({ textarea: prompt, disabled: pending || !open, onError: setError });

  useEffect(() => {
    if (open) prompt.current?.focus();
  }, [open]);

  function reset() {
    setText("");
    setName("");
    setProjectIds([]);
    setModelChoice({});
    setCreatedId(undefined);
    setError("");
    setUnknownOutcome(false);
  }

  function cancel() {
    if (pending) return;
    reset();
    onCancel();
  }

  async function submit() {
    const firstMessage = text.trim();
    if (pending || blocked || unknownOutcome || !firstMessage) return;
    const tooLong = messageLengthProblem(firstMessage);
    if (tooLong) {
      setError(tooLong);
      return;
    }
    setPending(true);
    setError("");
    try {
      let agentId = createdId;
      if (!agentId) {
        const title = name.trim() || firstMessage.split("\n", 1)[0].slice(0, 60).trimEnd();
        agentId = await onCreate(title, projectIds, modelChoice);
        setCreatedId(agentId);
      }
      await onSend(agentId, firstMessage);
      reset();
      onStarted(agentId);
    } catch (error) {
      if (error instanceof UnknownCommandOutcome) {
        setUnknownOutcome(true);
        setError("Orchestra could not confirm what happened. Check the map for the session and its chat for your message before sending again.");
      } else {
        setError(error instanceof Error ? error.message : "The first message could not be sent.");
      }
    } finally {
      setPending(false);
    }
  }

  return <section className="workspace-chat new-session" hidden={!open} aria-labelledby="new-session-heading" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancel();
    }
  }}>
    <header className="chat-header">
      <div className="chat-header-copy"><h2 id="new-session-heading">New session</h2></div>
      <button type="button" className="chat-icon-button" aria-label="Close new session" onClick={cancel} disabled={pending}>×</button>
    </header>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="new-session-field" {...drop.dropProps}>First message
        <textarea ref={prompt} rows={6} placeholder="What would you like to work on?" enterKeyHint="send" {...assist.inputProps}
          value={text} onChange={(event) => setText(event.target.value)} disabled={pending} required
          onBlur={assist.onBlur} onKeyDown={(event) => {
            if (assist.handleKey(event) || event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit();
          }} />
      </label>
      {assist.menu}
      {drop.uploading > 0 && <p role="status">Attaching {drop.uploading} file{drop.uploading === 1 ? "" : "s"}…</p>}
      <label className="new-session-field">Session name <span>(optional)</span>
        <input value={name} placeholder="Uses the first line of your message" maxLength={60}
          onChange={(event) => setName(event.target.value)} disabled={pending || Boolean(createdId)} />
      </label>
      <div className="new-session-field" role="group" aria-label="Model">Model
        <ModelPicker placement="below" newTask disabled={pending || Boolean(createdId)}
          settings={chooseModelSettings({ source: "provider-default" }, modelChoice)}
          onChange={(change) => setModelChoice((current) => ({ ...current, ...change }))} />
      </div>
      {projects.length > 0 && <fieldset disabled={pending || Boolean(createdId)}>
        <legend>Repositories</legend>
        <p>{projectIds.length ? `Selected: ${projectIds.join(", ")}` : "General chat · no repository access"}</p>
        {projects.map(({ id }) => <label key={id}>
          <input type="checkbox" checked={projectIds.includes(id)} onChange={(event) => {
            const { checked } = event.target;
            setProjectIds((current) => checked ? [...current, id] : current.filter((selected) => selected !== id));
          }} />
          {id}
        </label>)}
      </fieldset>}
      {createdId && error && !unknownOutcome && <p>Your session is open. Retry to send the message to that session.</p>}
      {error && <p className="new-session-error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={cancel} disabled={pending}>Cancel</button>
        <button type="submit" disabled={blocked || pending || unknownOutcome || !text.trim()}>
          {pending ? "Sending…" : createdId ? "Retry message" : "Start session"}
        </button>
      </footer>
    </form>
  </section>;
}
