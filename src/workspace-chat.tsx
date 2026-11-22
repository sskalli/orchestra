import { agentAppearance } from "./workspace-agent-appearance.ts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import { LuMaximize2, LuMinimize2 } from "react-icons/lu";
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
  onStartImplementation?: () => Promise<void>;
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
  onAnswerProductQuestion?: (questionId: string, text: string) => Promise<void> | void;
  onResumeQueue?: () => Promise<void>;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
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
  agent, projectLabel, repositoryScope, delivery, taskPhase, taskDetail, onStartImplementation, modelLabel, usageLabel, draft: initialDraft, composerHeight, onComposerHeightChange, onDraftInput, onDraftChange, onSend, onSteer, onCancel, onResumeQueue, onAnswerProductQuestion, onClose,
  disabled, disabledReason, focusMessageId, focusRequest, onOpenAgent, onLifecycle, expanded, onToggleExpanded,
}: ChatProps) {
  const transcript = useRef<HTMLDivElement>(null);
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
  const [questionId, setQuestionId] = useState<string>();
  const [startingImplementation, setStartingImplementation] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resumingQueue, setResumingQueue] = useState(false);
  const [error, setError] = useState("");
  const { displayName } = agentAppearance(agent);
  const recipient = `${projectLabel ? `${projectLabel} / ` : ""}${displayName}`;
  const archived = agent.archivedAt !== undefined;
  const blocked = Boolean(disabled || archived || agent.lifecycleBusy || agent.nativeChild);
  const readyToSend = !blocked && !sending && Boolean(draft.trim());
  const question = agent.messages.find((entry) => entry.id === questionId && entry.productQuestion?.status === "pending");
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

  async function startImplementation() {
    if (!onStartImplementation || blocked || sending || startingImplementation) return;
    setStartingImplementation(true);
    setError("");
    try {
      await onStartImplementation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Implementation could not start.");
    } finally {
      setStartingImplementation(false);
    }
  }

  function sendFromComposer() {
    if (!questionId) {
      void send(onSend);
    } else if (question && onAnswerProductQuestion) {
      void send(async (text) => {
        await onAnswerProductQuestion(question.id, text);
        setQuestionId((current) => current === question.id ? undefined : current);
      });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendFromComposer();
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
    sendFromComposer();
  }

  const canAnswer = Boolean(onAnswerProductQuestion) && !blocked;
  const messageElements = useMemo(() => agent.messages.filter((message) =>
    message.productQuestion?.status === "pending" || !hiddenMessages.has(message.id)).map((message) => {
          const sender = message.role === "user" ? "USER" : message.role === "system" ? "SYSTEM" : displayName;
          const { productQuestion } = message;
          const systemKind = message.role === "system"
            ? productQuestion?.status === "answered" ? "notice" : message.kind
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
                  ) : systemKind ? <span className="chat-message-state">{systemMessageLabels[systemKind]}</span> : null}
                  {message.state === "queued" ? <span className="chat-message-state">Queued</span> : null}
                  {message.state === "failed" ? <span className="chat-message-state chat-message-state--failed">Failed</span> : null}
                  {message.state === "cancelled" ? <span className="chat-message-state">Stopped</span> : null}
                </div>
                <div className="chat-markdown">
                  <Markdown skipHtml disallowedElements={["img"]} components={markdownComponents}>{message.text}</Markdown>
                  {message.state === "streaming" ? <span className="chat-stream-cursor" aria-label="Responding" /> : null}
                </div>
                {productQuestion?.status === "pending" && canAnswer && (
                  <button className="chat-steer" type="button" onClick={() => {
                    setQuestionId(message.id);
                    composer.current?.querySelector("textarea")?.focus();
                  }}>Answer question</button>
                )}
              </div>
            </article>
          );
        }), [agent.messages, canAnswer, displayName, hiddenMessages]);

  return (
    <section ref={chat} className="workspace-chat" aria-label={`${recipient} chat`}>
      <header className="chat-header">
        <div className="chat-header-copy">
          <h2 title={displayName}>{displayName}</h2>
          <span className="chat-agent-status">{projectLabel ? `Project: ${projectLabel} · ` : ""}{archived ? "Archived" : agent.lifecycleBusy ? "Updating…" : statusLabels[agent.status]}</span>
          {repositoryScope && <span className="chat-agent-status">Repositories: {repositoryScope.join(", ")}</span>}
          {taskPhase === "planning" && <span className="chat-agent-status">{repositoryScope ? "Planning · read-only" : "General chat"}</span>}
          {modelLabel && <span className="chat-agent-status">{modelLabel}</span>}
          {usageLabel && <span className="chat-agent-status" title={usageLabel}>{usageLabel}</span>}
        </div>
        <details className="chat-lifecycle-menu">
          <summary aria-label="Agent actions" title="Chat actions">⋯</summary>
          <div>
            <button type="button" title="Clear the visible log; conversation history is retained" onClick={(event) => {
              const menu = event.currentTarget.closest("details");
              menu?.removeAttribute("open");
              menu?.querySelector("summary")?.focus();
              setHiddenMessages(new Set(agent.messages
                .filter((message) => message.productQuestion?.status !== "pending")
                .map((message) => message.id)));
              pinToBottom.current = true;
            }}>Clear chat</button>
            {onLifecycle && <>
            <button type="button" disabled={agent.lifecycleBusy} onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onLifecycle(archived ? "restore" : "archive");
            }}>{archived ? "Restore" : "Archive task"}</button>
            <button type="button" disabled={agent.lifecycleBusy} onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onLifecycle("delete");
            }}>Delete permanently…</button>
            </>}
          </div>
        </details>
        {onToggleExpanded && (
          <button className="chat-icon-button" type="button" onClick={onToggleExpanded}
            aria-label={expanded ? "Restore conversation size" : "Expand conversation"}
            title={expanded ? "Restore conversation size" : "Expand conversation"}>
            {expanded ? <LuMinimize2 aria-hidden="true" /> : <LuMaximize2 aria-hidden="true" />}
          </button>
        )}
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
      <div className="chat-transcript" role="log" aria-label={`Conversation with ${recipient}`} aria-relevant="additions"
        ref={transcript} onScroll={(event) => {
          syncPinState(event.currentTarget);
        }}>
        {showJumpToLatest && <button className="chat-jump-latest" type="button" onClick={scrollToLatest}
          aria-label="Jump to latest message" title="Jump to latest message">
          <span aria-hidden="true">↓</span>
        </button>}
        {agent.messages.length === 0 ? (
          <p className="chat-empty">
            {agent.nativeChild ? "No messages yet." : `Send ${displayName} a message.`}
          </p>
        ) : null}
        {messageElements}
      </div>

      {!archived && !agent.nativeChild && <>
      <div ref={divider} className="chat-composer-resize" role="separator" tabIndex={0} aria-orientation="horizontal"
        aria-label="Resize chat input" aria-controls={composerId}
        onPointerDown={startComposerResize} onPointerMove={moveComposerResize} onPointerUp={endComposerResize}
        onPointerCancel={endComposerResize} onLostPointerCapture={endComposerResize} onKeyDown={composerResizeKey} />
      <form id={composerId} ref={composer} className="chat-composer" style={{ height: composerHeight }} onSubmit={submit}>
        {agent.queueDepth > 0 || agent.status === "working" ? (
          <div className="chat-queue" aria-live="polite">
            {agent.queueDepth > 0 ? `${agent.queueDepth} queued${agent.queuePaused ? " · paused" : ""}` : "New messages queue while this agent is working."}
            {agent.queuePaused && onResumeQueue && <button className="chat-steer" type="button"
              disabled={blocked || resumingQueue} onClick={() => void resumeQueue()}>Resume queue</button>}
          </div>
        ) : null}
        {blocked && disabledReason && !shownInConversation(disabledReason) ? <p className="chat-disabled">{disabledReason}</p> : null}
        {error && !shownInConversation(error) ? <p className="chat-error" role="alert">{error}</p> : null}
        {questionId && <div className="chat-queue">
          <span>{question ? `Answering: ${question.text.split("\n", 1)[0].slice(0, 120)}` : "This question no longer needs an answer."}</span>
          <button className="chat-steer" type="button" onClick={() => setQuestionId(undefined)}>Cancel reply</button>
        </div>}
        <div className="chat-composer-box">
          <span className="chat-input-prompt" aria-hidden="true">&gt;</span>
          <textarea aria-label={`Message ${recipient}`} rows={3} disabled={Boolean(agent.lifecycleBusy)}
            value={draft} onChange={(event) => updateDraft(event.target.value)} onBlur={flushDraft} onKeyDown={handleComposerKey} />
        </div>
        {onStartImplementation && agent.messages.some((entry) => entry.role === "assistant" && !entry.state) && (
          <button className="chat-steer" type="button"
            disabled={blocked || sending || startingImplementation || agent.canCancel || agent.queueDepth > 0}
            onClick={() => void startImplementation()}>
            {startingImplementation ? "Starting…" : taskPhase === "blocked" ? "Retry implementation"
              : taskPhase === "ready-for-review" ? "Revise candidate" : "Start implementation"}
          </button>
        )}
        {!questionId && agent.canSteer && onSteer ? (
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
