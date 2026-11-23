import { needsUserInput } from "./workspace-status.ts";
import { agentAppearance } from "./workspace-agent-appearance.ts";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import { LuEllipsis, LuLoaderCircle, LuMessageSquareX } from "react-icons/lu";
import type { SystemMessageKind, WorkspaceAgent } from "./workspace-runtime.ts";

import "./workspace-chat.css";

type ChatAgent = WorkspaceAgent;

type ChatProps = {
  agent: ChatAgent;
  projectLabel?: string;
  repositoryScope?: string[];
  delivery?: { members: { projectId: string; path: string; revision?: string }[]; taskChecks?: string };
  taskPhase?: NonNullable<WorkspaceAgent["directTask"]>["phase"];
  taskDetail?: string;
  modelLabel?: string;
  usageLabel?: string;
  draft: string;
  composerHeight?: number;
  onComposerHeightChange: (height: number) => void;
  onDraftInput: (text: string) => void;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => Promise<void> | void;
  onSteer?: (text: string) => Promise<void> | void;
  onCancel?: () => Promise<void>;
  onApproveImplementation?: (requestId: string) => Promise<void>;
  onResumeQueue?: () => Promise<void>;
  onClose: () => void;
  onOpenAgent?: (id: string) => void;
  onLifecycle?: (action: "archive" | "restore" | "delete") => void;
  disabled?: boolean;
  disabledReason?: string;
  focusMessageId?: string;
  focusRequest?: number;
};

const statusLabels = {
  idle: "Idle",
  working: "Working",
  attention: "Needs attention",
  "awaiting-confirmation": "Awaiting confirmation",
  done: "Complete",
  error: "Failed",
  notice: "Update available",
};

const systemMessageLabels: Record<SystemMessageKind, string> = {
  error: "Error",
  action: "Action required",
  warning: "Warning",
  notice: "Notice",
  success: "Success",
};

const markdownComponents: Components = {
  a: ({ children, href }) => {
    if (!href) return children;
    const external = /^(?:https?:)?\/\//i.test(href);
    return <a href={href} target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}>{children}</a>;
  },
};

function Conversation({
  agent, projectLabel, repositoryScope, delivery, taskPhase, taskDetail, modelLabel, usageLabel, draft: initialDraft, composerHeight, onComposerHeightChange, onDraftInput, onDraftChange, onSend, onSteer, onCancel, onResumeQueue, onApproveImplementation, onClose,
  disabled, disabledReason, focusMessageId, focusRequest, onOpenAgent, onLifecycle,
}: ChatProps) {
  const transcript = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const actionsId = useId();
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    if (!actionsOpen) return;
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !actions.current?.contains(event.target)) setActionsOpen(false);
    };
    const dismissWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setActionsOpen(false);
      actionsButton.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("click", dismissOutside, true);
    window.addEventListener("keydown", dismissWithEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("click", dismissOutside, true);
      window.removeEventListener("keydown", dismissWithEscape, true);
    };
  }, [actionsOpen]);
  const [hiddenMessages, setHiddenMessages] = useState<Set<string>>(() => new Set());
  useLayoutEffect(() => {
    if (!focusMessageId) return;
    setHiddenMessages((previous) => {
      if (!previous.has(focusMessageId)) return previous;
      const next = new Set(previous);
      next.delete(focusMessageId);
      return next;
    });
  }, [focusMessageId, focusRequest]);
  const chat = useRef<HTMLElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const composerId = useId();
  const resizeDrag = useRef<{ pointerId: number; start: number; height: number } | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const pendingHeight = useRef<number | null>(null);
  const composerLimits = useRef({ min: 0, max: 0 });
  const messages = useRef(new Map<string, HTMLElement>());
  const pinToBottom = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(initialDraft);
  const draftRevision = useRef(0);
  const draftChangeRef = useRef(onDraftChange);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  draftChangeRef.current = onDraftChange;
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resumingQueue, setResumingQueue] = useState(false);
  const [approvingImplementation, setApprovingImplementation] = useState(false);
  const [error, setError] = useState("");
  const { displayName } = agentAppearance(agent);
  const recipient = `${projectLabel ? `${projectLabel} / ` : ""}${displayName}`;
  const archived = agent.archivedAt !== undefined;
  const blocked = Boolean(disabled || archived || agent.lifecycleBusy || agent.nativeChild);
  const readyToSend = !blocked && !sending && Boolean(draft.trim());
  const hasFocusMessage = agent.messages.some((message) => message.id === focusMessageId);
  const shownInConversation = (detail: string) => agent.messages.some((message) =>
    message.role === "system" && Boolean(message.text) && (message.text.includes(detail) || detail.includes(message.text)));

  function flushDraft() {
    if (draftTimer.current === undefined) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = undefined;
    draftChangeRef.current(draftRef.current);
  }

  function updateDraft(value: string) {
    draftRef.current = value;
    draftRevision.current += 1;
    onDraftInput(value);
    setDraft(value);
    if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = undefined;
      draftChangeRef.current(draftRef.current);
    }, 250);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flushDraft();
    };
  }, []);

  useEffect(() => {
    if (draftTimer.current === undefined && draftRef.current !== initialDraft) {
      draftRef.current = initialDraft;
      setDraft(initialDraft);
    }
  }, [initialDraft]);

  function composerBounds() {
    const height = chat.current?.clientHeight ?? 0;
    const header = chat.current?.querySelector<HTMLElement>(".chat-header")?.offsetHeight ?? 51;
    const max = Math.max(0, Math.min(height * 0.65, height - header - 64));
    return { min: Math.min(80, max), max };
  }

  function updateDivider() {
    const element = divider.current;
    const height = composer.current?.getBoundingClientRect().height;
    if (!element || height === undefined) return;
    const { min, max } = composerBounds();
    composerLimits.current = { min, max };
    element.setAttribute("aria-valuemin", String(Math.round(min)));
    element.setAttribute("aria-valuemax", String(Math.round(max)));
    element.setAttribute("aria-valuenow", String(Math.round(Math.max(min, Math.min(max, height)))));
  }

  useEffect(() => {
    const container = chat.current;
    const form = composer.current;
    if (!container || !form) return;
    const observer = new ResizeObserver(() => {
      updateDivider();
      if (pinToBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
    observer.observe(container);
    observer.observe(form);
    updateDivider();
    return () => {
      observer.disconnect();
      if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    };
  }, [archived]);

  function applyComposerHeight() {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    if (pendingHeight.current === null || !composer.current) return;
    composer.current.style.height = `${pendingHeight.current}px`;
    divider.current?.setAttribute("aria-valuenow", String(pendingHeight.current));
  }

  function setComposerHeight(height: number) {
    const { min, max } = composerLimits.current;
    pendingHeight.current = Math.round(Math.max(min, Math.min(max, height)));
    if (resizeFrame.current === null) resizeFrame.current = requestAnimationFrame(applyComposerHeight);
  }

  function startComposerResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !composer.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    composerLimits.current = composerBounds();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDrag.current = { pointerId: event.pointerId, start: event.clientY, height: composer.current.getBoundingClientRect().height };
  }

  function moveComposerResize(event: PointerEvent<HTMLDivElement>) {
    const drag = resizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setComposerHeight(drag.height + drag.start - event.clientY);
  }

  function endComposerResize(event: PointerEvent<HTMLDivElement>) {
    if (resizeDrag.current?.pointerId !== event.pointerId) return;
    applyComposerHeight();
    resizeDrag.current = null;
    if (pendingHeight.current !== null) onComposerHeightChange(pendingHeight.current);
    pendingHeight.current = null;
  }

  function composerResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    const direction = event.key === "ArrowUp" || event.key === "PageUp" ? 1
      : event.key === "ArrowDown" || event.key === "PageDown" ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (resizeDrag.current) return;
    const { min, max } = composerBounds();
    composerLimits.current = { min, max };
    const current = pendingHeight.current ?? composer.current?.getBoundingClientRect().height ?? min;
    const step = event.key.startsWith("Page") ? 32 : 8;
    setComposerHeight(event.key === "Home" ? min : event.key === "End" ? max : current + direction * step);
    applyComposerHeight();
    if (pendingHeight.current !== null) onComposerHeightChange(pendingHeight.current);
    pendingHeight.current = null;
  }

  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && pinToBottom.current) {
      element.scrollTop = element.scrollHeight;
      setShowJumpToLatest(false);
    }
  }, [agent.messages]);

  function syncPinState(element: HTMLDivElement) {
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
    pinToBottom.current = pinned;
    setShowJumpToLatest(!pinned);
  }

  function scrollToLatest() {
    const element = transcript.current;
    if (!element) return;
    pinToBottom.current = true;
    element.scrollTop = element.scrollHeight;
    setShowJumpToLatest(false);
  }

  useLayoutEffect(() => {
    if (!focusMessageId) return;
    const message = messages.current.get(focusMessageId);
    const element = transcript.current;
    if (!message || !element) return;
    pinToBottom.current = false;
    setShowJumpToLatest(true);
    message.focus({ preventScroll: true });
    const viewport = element.getBoundingClientRect();
    const target = message.getBoundingClientRect();
    if (target.top < viewport.top) element.scrollTop += target.top - viewport.top;
    else if (target.bottom > viewport.bottom) element.scrollTop += target.bottom - viewport.bottom;
  }, [focusMessageId, focusRequest, hasFocusMessage, hiddenMessages]);

  async function send(action: (text: string) => Promise<void> | void) {
    if (!readyToSend) return;
    const submitted = draft;
    const revision = draftRevision.current;
    flushDraft();
    setSending(true);
    setError("");
    try {
      await action(submitted);
      if (mounted.current && draftRevision.current === revision) {
        updateDraft("");
      }
      if (mounted.current) flushDraft();
      pinToBottom.current = true;
      const element = transcript.current;
      if (element) element.scrollTop = element.scrollHeight;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(onSend);
  }

  async function resumeQueue() {
    if (!onResumeQueue || resumingQueue || blocked) return;
    setResumingQueue(true);
    setError("");
    try {
      await onResumeQueue();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Queue could not be resumed.");
    } finally {
      setResumingQueue(false);
    }
  }

  async function cancelTurn() {
    if (!onCancel || !agent.canCancel || cancelling || blocked) return;
    setCancelling(true);
    setError("");
    try {
      await onCancel();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The current turn could not be stopped.");
    } finally {
      setCancelling(false);
    }
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(onSend);
  }

  const approveImplementation = useCallback(async (requestId: string) => {
    if (!onApproveImplementation || approvingImplementation || blocked || agent.canCancel || agent.queueDepth) return;
    setApprovingImplementation(true);
    setError("");
    try {
      await onApproveImplementation(requestId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not allow edits.");
    } finally {
      setApprovingImplementation(false);
    }
  }, [agent.canCancel, agent.queueDepth, approvingImplementation, blocked, onApproveImplementation]);

  const messageElements = useMemo(() => agent.messages.filter((message) =>
    needsUserInput(message) || !hiddenMessages.has(message.id)).map((message) => {
          const sender = message.role === "user" ? "USER" : message.role === "system" ? "SYSTEM" : "COMPUTER";
          const { productQuestion, implementationRequest } = message;
          const systemKind = message.role === "system"
            ? productQuestion?.status === "answered" || implementationRequest && implementationRequest.status !== "pending" ? "notice" : message.kind
            : undefined;
          return (
            <article key={message.id} tabIndex={-1} className={`chat-message chat-message--${message.role}${systemKind ? ` chat-message--${systemKind}` : ""}`}
              ref={(element) => {
                if (element) messages.current.set(message.id, element);
                else messages.current.delete(message.id);
              }}>
              <div className="chat-message-content">
                <div className="chat-message-header">
                  <strong><span aria-hidden="true">&gt; </span>{sender}:</strong>
                  {productQuestion ? (
                    <span className="chat-message-state">{productQuestion.status === "pending" ? "Question awaiting answer" : "Question answered"}</span>
                  ) : implementationRequest ? <span className="chat-message-state">
                    {implementationRequest.status === "pending" ? "Awaiting your permission to edit files"
                      : implementationRequest.status === "approved" ? "Edits allowed" : "Request superseded"}
                  </span> : systemKind ? <span className="chat-message-state">{systemMessageLabels[systemKind]}</span> : null}
                  {message.state === "queued" ? <span className="chat-message-state">Queued</span> : null}
                  {message.state === "failed" ? <span className="chat-message-state chat-message-state--failed">Failed</span> : null}
                  {message.state === "cancelled" ? <span className="chat-message-state">Stopped</span> : null}
                </div>
                <div className="chat-markdown">
                  {implementationRequest
                    ? <p className="chat-implementation-summary">{message.text}</p>
                    : <Markdown skipHtml disallowedElements={["img"]} components={markdownComponents}>{message.text}</Markdown>}
                  {message.state === "streaming" ? <span className="chat-stream-cursor" aria-label="Responding" /> : null}
                </div>
                {implementationRequest?.status === "pending" && onApproveImplementation && !archived && (
                  <button className="chat-steer" type="button"
                    disabled={blocked || approvingImplementation || Boolean(agent.canCancel) || agent.queueDepth > 0}
                    onClick={() => void approveImplementation(message.id)}>
                    {approvingImplementation ? "Allowing edits…" : "Allow edits"}
                  </button>
                )}
              </div>
            </article>
          );
        }), [agent.messages, agent.canCancel, agent.queueDepth, approveImplementation, approvingImplementation, archived, blocked, hiddenMessages, onApproveImplementation]);

  const headerStatus = archived ? "Archived" : agent.lifecycleBusy ? "Updating…" : statusLabels[agent.status];
  const headerTone = archived || agent.lifecycleBusy ? "idle" : agent.status;
  const showWorkingIndicator = !archived && (headerTone === "working" || agent.canCancel);
  const agentTooltipId = useId();
  const nameTooltip = [
    projectLabel && `Project: ${projectLabel}`,
    repositoryScope && `Repositories: ${repositoryScope.join(", ")}`,
    taskPhase === "planning" && (repositoryScope ? "Planning · read-only" : "General chat"),
    modelLabel,
    usageLabel,
  ].filter(Boolean).join("\n");

  return (
    <section ref={chat} className="workspace-chat" aria-label={`${recipient} chat`}>
      <header className="chat-header">
        <div className="chat-header-copy">
          <h2 className="chat-agent-title" tabIndex={0} aria-describedby={agentTooltipId}>
            <span className="chat-agent-name">{displayName}</span>
            <span className="chat-agent-divider" aria-hidden="true">|</span>
            <span className="chat-agent-status" data-status={headerTone}>{headerStatus.toLowerCase()}</span>
            {(headerTone === "working" || (!archived && agent.canCancel)) && <LuLoaderCircle className="chat-working-spinner" aria-hidden="true" />}
          </h2>
          <div className="chat-agent-tooltip" id={agentTooltipId} role="tooltip">
            <strong>{displayName}</strong>
            {nameTooltip && <span>{nameTooltip}</span>}
          </div>
        </div>
        <div ref={actions} className="chat-lifecycle-menu">
          <button ref={actionsButton} className="interface-icon-button" type="button" aria-label="More actions"
            title="More actions" aria-expanded={actionsOpen} aria-controls={actionsId}
            onClick={() => setActionsOpen((open) => !open)}>
            <LuEllipsis aria-hidden="true" strokeWidth={1.5} />
          </button>
          <div id={actionsId} hidden={!actionsOpen}>
            <button type="button" className="interface-icon-button" aria-label="Clear chat" title="Clear chat" onClick={() => {
              setActionsOpen(false);
              actionsButton.current?.focus();
              setHiddenMessages(new Set(agent.messages
                .filter((message) => !needsUserInput(message))
                .map((message) => message.id)));
              pinToBottom.current = true;
            }}><LuMessageSquareX aria-hidden="true" strokeWidth={1.5} /></button>
            {onLifecycle && <>
              <button type="button" disabled={agent.lifecycleBusy} onClick={() => {
                setActionsOpen(false);
                onLifecycle(archived ? "restore" : "archive");
              }}>{archived ? "Restore" : "Archive task"}</button>
              <button type="button" disabled={agent.lifecycleBusy} onClick={() => {
                setActionsOpen(false);
                onLifecycle("delete");
              }}>Delete permanently…</button>
            </>}
          </div>
        </div>
        <button className="chat-icon-button" type="button" onClick={onClose}
          aria-label="Close conversation" title="Close conversation">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {delivery && <details className="chat-delivery">
        <summary>Delivery snapshots · Ready for review</summary>
        <ul>
          {delivery.members.map(({ projectId, path, revision }) => <li key={projectId}>
            <label>{projectId}<input aria-label={`${projectId} candidate worktree`} value={path} readOnly
              onFocus={(event) => event.currentTarget.select()} /></label>
            {revision && <label>Revision<input aria-label={`${projectId} candidate revision`} value={revision} readOnly
              onFocus={(event) => event.currentTarget.select()} /></label>}
          </li>)}
        </ul>
        {delivery.taskChecks && <p className="chat-delivery-checks">Checks: {delivery.taskChecks}</p>}
        <p>Review and merge each repository separately.</p>
      </details>}

      {agent.nativeChild && <div className="chat-native-child">
        <span>Read-only subagent transcript.</span>
        {agent.parentId && <button className="chat-steer" type="button"
          onClick={() => onOpenAgent?.(agent.parentId!)}>Open parent conversation</button>}
      </div>}
      {taskDetail && <p className="chat-task-detail" role="status">{taskDetail}</p>}
      {archived && <p className="chat-archive-notice">Archived {new Date(agent.archivedAt!).toLocaleString()}. Restore to continue this conversation.</p>}
      {showWorkingIndicator && <div className="chat-working-indicator" role="status" aria-live="polite">
        <LuLoaderCircle className="chat-working-spinner" aria-hidden="true" />
        <span>{displayName} is working…</span>
      </div>}
      <div className="chat-transcript-wrap">
        <div className="chat-transcript" role="log" aria-label={`Conversation with ${recipient}`} aria-relevant="additions"
          ref={transcript} onScroll={(event) => {
            syncPinState(event.currentTarget);
          }}>
          {agent.messages.length === 0 ? (
            <p className="chat-empty">
              {agent.nativeChild ? "No messages yet." : `Send ${displayName} a message.`}
            </p>
          ) : null}
          {messageElements}
        </div>
        {showJumpToLatest && <button className="chat-jump-latest" type="button" onClick={scrollToLatest}
          aria-label="Jump to latest message" title="Jump to latest message">
          <span aria-hidden="true">↓</span>
        </button>}
      </div>

      {!archived && !agent.nativeChild && <>
      <div ref={divider} className="chat-composer-resize" role="separator" tabIndex={0} aria-orientation="horizontal"
        aria-label="Resize chat input" aria-controls={composerId}
        onPointerDown={startComposerResize} onPointerMove={moveComposerResize} onPointerUp={endComposerResize}
        onPointerCancel={endComposerResize} onLostPointerCapture={endComposerResize} onKeyDown={composerResizeKey} />
      <form id={composerId} ref={composer} className="chat-composer" style={{ height: composerHeight }} onSubmit={submit}>
        {agent.queueDepth > 0 || agent.status === "working" ? (
          <div className="chat-queue" aria-live="polite">
            {agent.queueDepth > 0 ? `${agent.queueDepth} queued${agent.queuePaused ? " · paused" : ""}` : "Agent is working — new messages will queue."}
            {agent.queuePaused && onResumeQueue && <button className="chat-steer" type="button"
              disabled={blocked || resumingQueue} onClick={() => void resumeQueue()}>Resume queue</button>}
          </div>
        ) : null}
        {blocked && disabledReason && !shownInConversation(disabledReason) ? <p className="chat-disabled">{disabledReason}</p> : null}
        {error && !shownInConversation(error) ? <p className="chat-error" role="alert">{error}</p> : null}
        <div className="chat-composer-box">
          <span className="chat-input-prompt" aria-hidden="true">&gt;</span>
          <textarea aria-label={`Message ${recipient}`}
            placeholder={repositoryScope?.length ? "Ask a question or describe a change" : undefined} rows={3} disabled={Boolean(agent.lifecycleBusy)}
            value={draft} onChange={(event) => updateDraft(event.target.value)} onBlur={flushDraft} onKeyDown={handleComposerKey} />
        </div>
        {agent.canSteer && onSteer ? (
          <button className="chat-steer" type="button" disabled={!readyToSend}
            onClick={() => void send(onSteer)}>Steer current turn</button>
        ) : null}
        {agent.canCancel && onCancel ? (
          <button className="chat-steer" type="button" disabled={blocked || cancelling}
            onClick={() => void cancelTurn()}>{cancelling ? "Stopping…" : "Stop current turn"}</button>
        ) : null}
      </form>
      </>}
    </section>
  );
}

export function WorkspaceChat(props: ChatProps) {
  return <Conversation key={props.agent.id} {...props} />;
}
