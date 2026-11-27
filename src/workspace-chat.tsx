import { OrbitSpinner } from "./workspace-orbit-spinner.tsx";
import { needsUserInput } from "./workspace-status.ts";
import { agentAppearance } from "./workspace-agent-appearance.ts";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent } from "react";
import { LuArrowUp, LuEllipsis, LuSquare } from "react-icons/lu";
import { CopyButton } from "./copy-button.tsx";
import { ChatMarkdown, InlineCodeCopy } from "./workspace-markdown.tsx";
import type { ApprovalChoice, PermissionApproval, SystemMessageKind, WorkspaceAgent, WorkspaceMessage } from "./workspace-runtime.ts";
import { messageLengthProblem, OrderedSends, restoredDraft, retryableMessageId } from "./workspace-chat-recovery.ts";

import "./workspace-chat.css";

type ChatAgent = WorkspaceAgent;
type RepositoryScope = { id: string; path?: string };
type ResolveCommandApproval = (requestId: string, decision: ApprovalChoice) => Promise<void>;

type ChatProps = {
  agent: ChatAgent;
  projectLabel?: string;
  repositoryScope?: RepositoryScope[];
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
  /** Puts unsent texts back in front of the task's stored draft after this chat has closed. */
  onDraftRestore?: (unsent: string[]) => void;
  onSend: (text: string) => Promise<void> | void;
  onSteer?: (text: string) => Promise<void> | void;
  onCancel?: () => Promise<void>;
  onApproveImplementation?: (requestId: string) => Promise<void>;
  onResolveCommandApproval?: ResolveCommandApproval;
  onResumeQueue?: () => Promise<void>;
  onClose: () => void;
  onOpenAgent?: (id: string) => void;
  onRename?: (name: string) => Promise<void>;
  onLifecycle?: (action: "archive" | "restore" | "delete") => void;
  disabled?: boolean;
  disabledReason?: string;
  /** A provider problem that does not block sending, such as a usage limit. */
  providerNotice?: string;
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

const messageTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function ImplementationTargets({ request, repositories }: {
  request: NonNullable<WorkspaceMessage["implementationRequest"]>;
  repositories: RepositoryScope[];
}) {
  return (
    <dl className="chat-implementation-targets" aria-label="Write scope">
      {repositories.map(({ id, path }) => {
        const target = request.targets?.find(({ projectId }) => projectId === id);
        const worktree = target?.mode === "worktree" ? target : undefined;
        const checkout = target?.mode === "checkout";
        const location = checkout ? path : worktree?.path;
        return (
          <div key={id}>
            <dt>{id}</dt>
            <dd>
              <span>{checkout ? "Configured checkout" : worktree ? "New linked worktree" : "Isolated worktree"}</span>
              {location && <code>{location}</code>}
              {worktree && (worktree.branch ? <span>Branch <code>{worktree.branch}</code></span> : <span>Detached HEAD</span>)}
              {checkout && <span className="chat-implementation-checkout-warning">
                Edits apply directly to this checkout.
              </span>}
              {!target && <span>Path assigned by Orchestra.</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const commandApprovalLabels: Record<PermissionApproval["status"], string> = {
  pending: "Approval required",
  approved: "Approved once",
  "approved-for-session": "Allowed for this task",
  declined: "Declined",
  expired: "Approval expired",
  unconfirmed: "Decision delivery unconfirmed",
};

const approvalChoiceLabels: Record<ApprovalChoice, [idle: string, busy: string]> = {
  decline: ["Decline", "Declining…"],
  approveForSession: ["Allow for this task", "Allowing…"],
  approve: ["Approve once", "Approving…"],
};

function approvalWarning(approval: PermissionApproval) {
  const session = approval.choices?.includes("approveForSession")
    ? " Allow for this task also covers similar requests until Orchestra restarts." : "";
  if (approval.kind === "fileChange") return "Approving lets the agent apply these file changes outside its current write access." + session;
  if (approval.kind === "permissions") return "Approving extends the agent’s sandbox with the access listed below." + session;
  return "Approving runs this command outside the sandbox with your local account’s access." + session;
}

function PathList({ paths }: { paths: string[] }) {
  return <>{paths.map((path) => <code key={path} className="chat-command-approval-path">{path}</code>)}</>;
}

function CommandApprovalCard({ approval, requestId, blocked, onResolve }: {
  approval: PermissionApproval;
  requestId: string;
  blocked: boolean;
  onResolve?: ResolveCommandApproval;
}) {
  const [submitting, setSubmitting] = useState<ApprovalChoice>();
  const [error, setError] = useState("");
  // Entries saved before choices were recorded offered a single approval and a decline.
  const choices = (["decline", "approveForSession", "approve"] as const)
    .filter((choice) => (approval.choices ?? ["approve", "decline"]).includes(choice));

  async function resolve(decision: ApprovalChoice) {
    if (approval.status !== "pending" || blocked || !onResolve || submitting) return;
    setSubmitting(decision);
    setError("");
    try {
      await onResolve(requestId, decision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not resolve this approval.");
      setSubmitting(undefined);
    }
  }

  return (
    <div className="chat-command-approval">
      {approval.status === "pending" && <p className="chat-command-approval-warning">{approvalWarning(approval)}</p>}
      <dl>
        {approval.command && <div><dt>Command</dt><dd><code>{approval.command}</code></dd></div>}
        {approval.files && <div><dt>Files</dt><dd><PathList paths={approval.files} /></dd></div>}
        {approval.writePaths && <div><dt>Write access</dt><dd><PathList paths={approval.writePaths} /></dd></div>}
        {approval.readPaths && <div><dt>Read access</dt><dd><PathList paths={approval.readPaths} /></dd></div>}
        {approval.network && <div><dt>Network</dt><dd>{approval.network}</dd></div>}
        {approval.cwd && <div><dt>Working directory</dt><dd><code>{approval.cwd}</code></dd></div>}
        {approval.reason && <div><dt>Reason</dt><dd>{approval.reason}</dd></div>}
      </dl>
      {approval.status === "pending" && onResolve && (
        <>
          {approval.declineStopsTurn && <p className="chat-command-approval-note">Declining stops this turn so you can reply with other instructions.</p>}
          <div className="chat-command-approval-actions">
            {choices.map((choice) => (
              <button key={choice} type="button" className="chat-steer" disabled={blocked || !!submitting}
                onClick={() => void resolve(choice)}>{approvalChoiceLabels[choice][submitting === choice ? 1 : 0]}</button>
            ))}
          </div>
          {error && <p className="chat-error" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}

// Snapshots replace every message object, so unchanged text skips Markdown parsing, which is slow for long pastes.
const MessageMarkdown = memo(ChatMarkdown);

function MessageActions({ message, onRetry, retrying, retryDisabled }: {
  message: WorkspaceMessage; onRetry?: () => void; retrying?: boolean; retryDisabled?: boolean;
}) {
  const time = message.createdAt === undefined ? undefined : new Date(message.createdAt);
  return (
    <footer className={`chat-message-actions${onRetry ? " chat-message-actions--retry" : ""}`}>
      {onRetry && <button type="button" className="chat-steer" disabled={retryDisabled || retrying}
        onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</button>}
      {time && Number.isFinite(time.getTime()) &&
        <time dateTime={time.toISOString()} title={time.toLocaleString()}>{messageTime.format(time)}</time>}
      <CopyButton text={message.commandApproval?.command ?? message.text} label="Copy message" />
    </footer>
  );
}

function Conversation({
  agent, projectLabel, repositoryScope, delivery, taskPhase, taskDetail, modelLabel, usageLabel, draft: initialDraft, composerHeight, onComposerHeightChange, onDraftInput, onDraftChange, onDraftRestore, onSend, onSteer, onCancel, onResumeQueue, onApproveImplementation, onClose,
  disabled, disabledReason, providerNotice, focusMessageId, focusRequest, onOpenAgent, onLifecycle, onRename, onResolveCommandApproval,
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
  // Images and diagrams grow after they load; keep a pinned transcript at the bottom when any message resizes.
  const messageResizes = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (pinToBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
    messageResizes.current = observer;
    for (const element of messages.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      messageResizes.current = null;
    };
  }, []);
  // One stable ref callback per message, so re-rendering a streaming message does not re-register every article.
  const messageRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  function messageRef(id: string) {
    let callback = messageRefs.current.get(id);
    if (!callback) {
      callback = (element) => {
        const previous = messages.current.get(id);
        if (previous && previous !== element) messageResizes.current?.unobserve(previous);
        if (element) {
          messages.current.set(id, element);
          messageResizes.current?.observe(element);
        } else {
          messages.current.delete(id);
          messageRefs.current.delete(id);
        }
      };
      messageRefs.current.set(id, callback);
    }
    return callback;
  }
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(initialDraft);
  const draftRevision = useRef(0);
  const draftChangeRef = useRef(onDraftChange);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  draftChangeRef.current = onDraftChange;
  const [steerEnabled, setSteerEnabled] = useState(false);
  const [pendingSends, setPendingSends] = useState(0);
  const sends = useRef(new OrderedSends());
  const [retrying, setRetrying] = useState(false);
  const [retriedId, setRetriedId] = useState<string>();
  const retriedRef = useRef<string>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const [resumingQueue, setResumingQueue] = useState(false);
  const [approvingImplementation, setApprovingImplementation] = useState(false);
  const [error, setError] = useState("");
  const { displayName } = agentAppearance(agent);
  const title = useRef<HTMLHeadingElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameErrorId = useId();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);

  const editingName = nameDraft !== null;
  useLayoutEffect(() => {
    if (editingName) {
      renameInput.current?.focus();
      renameInput.current?.select();
    }
  }, [editingName]);

  function closeRename() {
    setNameDraft(null);
    setRenameError("");
    requestAnimationFrame(() => title.current?.focus());
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = nameDraft?.trim();
    if (!onRename || !name || renaming || agent.lifecycleBusy) return;
    setRenaming(true);
    setRenameError("");
    try {
      await onRename(name);
      closeRename();
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : "The task could not be renamed.";
      setRenameError(detail === "Invalid workspace command"
        ? "Restart Orchestra to load the server version that supports renaming."
        : detail);
      renameInput.current?.focus();
    } finally {
      setRenaming(false);
    }
  }

  const recipient = `${projectLabel ? `${projectLabel} / ` : ""}${displayName}`;
  const archived = agent.archivedAt !== undefined;
  const blocked = Boolean(disabled || archived || agent.lifecycleBusy || agent.nativeChild);
  const sending = pendingSends > 0;
  const readyToSend = !blocked && Boolean(draft.trim());
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
    return { min: Math.min(136, max), max };
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

  const lastScrollTop = useRef(0);
  function syncPinState(element: HTMLDivElement) {
    // Scroll events arrive a frame late, so content that grew meanwhile (images, diagrams) must not read as scrolling up.
    const movedUp = element.scrollTop < lastScrollTop.current - 1;
    lastScrollTop.current = element.scrollTop;
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 36 || (pinToBottom.current && !movedUp);
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
    const submitted = draftRef.current;
    const tooLong = messageLengthProblem(submitted.trim());
    if (tooLong) {
      setError(tooLong);
      return;
    }
    // Clear exactly the submitted text now, so typing during the request starts a new message.
    // Sends run in order; a failure cancels later ones and puts every unsent text back in order.
    updateDraft("");
    flushDraft();
    setPendingSends((count) => count + 1);
    setError("");
    const outcome = await sends.current.run(submitted, action);
    setPendingSends((count) => count - 1);
    if (outcome.sent) {
      pinToBottom.current = true;
      const element = transcript.current;
      if (element) element.scrollTop = element.scrollHeight;
      return;
    }
    if (!outcome.restore.length) return;
    if (!mounted.current) {
      // Another chat may own the composer now; merge into the stored draft instead of replacing it.
      onDraftRestore?.(outcome.restore);
      return;
    }
    updateDraft(restoredDraft(outcome.restore, draftRef.current));
    flushDraft();
    const failure = outcome.error;
    setError(failure instanceof Error ? failure.message : "Message could not be sent.");
  }

  const steerAction = steerEnabled && agent.canSteer ? onSteer : undefined;
  const retryId = retryableMessageId(agent.messages);
  // A retried message stays disabled until the resent message replaces it as the latest one.
  const retryDisabled = blocked || sending || retrying || retryId === retriedId || Boolean(agent.canCancel) ||
    agent.queueDepth > 0 || agent.status === "working";

  // Resends the failed message's text as a new message. The draft is left untouched.
  const retry = useCallback(async (id: string, text: string) => {
    // The ref also stops clicks that arrive before React re-renders the disabled button.
    if (retryDisabled || retriedRef.current === id) return;
    retriedRef.current = id;
    setRetrying(true);
    setRetriedId(id);
    setError("");
    try {
      await onSend(text);
    } catch (failure) {
      retriedRef.current = undefined;
      setRetriedId(undefined);
      setError(failure instanceof Error ? failure.message : "Message could not be sent.");
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }, [onSend, retryDisabled]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!showWorkingIndicator) void send(onSend);
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
    void send(steerAction ?? onSend);
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
          const { productQuestion, implementationRequest, commandApproval } = message;
          const resolved = productQuestion?.status === "answered" ||
            (implementationRequest && implementationRequest.status !== "pending") ||
            (commandApproval && commandApproval.status !== "pending");
          const systemKind = message.role === "system"
            ? resolved ? "notice" : commandApproval ? "action" : message.kind
            : undefined;
          return (
            <article key={message.id} tabIndex={-1} className={`chat-message chat-message--${message.role}${systemKind ? ` chat-message--${systemKind}` : ""}`}
              ref={messageRef(message.id)}>
              <div className="chat-message-content">
                <div className="chat-message-header">
                  <strong><span aria-hidden="true">&gt; </span>{sender}:</strong>
                  {productQuestion ? (
                    <span className="chat-message-state">{productQuestion.status === "pending" ? "Question awaiting answer" : "Question answered"}</span>
                  ) : implementationRequest ? <span className="chat-message-state">
                    {implementationRequest.status === "pending" ? "Awaiting your permission to edit files"
                      : implementationRequest.status === "approved" ? "Edits allowed" : "Request superseded"}
                  </span> : commandApproval ? <span className="chat-message-state">{commandApprovalLabels[commandApproval.status]}</span>
                    : systemKind ? <span className="chat-message-state">{systemMessageLabels[systemKind]}</span> : null}
                  {message.state === "queued" ? <span className="chat-message-state">Queued</span> : null}
                  {message.state === "failed" ? <span className="chat-message-state chat-message-state--failed">Failed</span> : null}
                  {message.state === "cancelled" ? <span className="chat-message-state">Stopped</span> : null}
                </div>
                {commandApproval ? (
                  <CommandApprovalCard approval={commandApproval} requestId={message.id} blocked={blocked}
                    onResolve={onResolveCommandApproval} />
                ) : <div className="chat-markdown">
                  {implementationRequest
                    ? <p className="chat-implementation-summary">{message.text}</p>
                    : <MessageMarkdown text={message.text} agentId={agent.id} idPrefix={message.id}
                      streaming={message.state === "streaming"} />}
                  {message.state === "streaming" ? <span className="chat-stream-cursor" aria-label="Responding" /> : null}
                </div>}
                {implementationRequest && !!repositoryScope?.length &&
                  <ImplementationTargets request={implementationRequest} repositories={repositoryScope} />}
                {implementationRequest?.status === "pending" && onApproveImplementation && !archived && (
                  <button className="chat-steer" type="button"
                    disabled={blocked || approvingImplementation || Boolean(agent.canCancel) || agent.queueDepth > 0}
                    onClick={() => void approveImplementation(message.id)}>
                    {approvingImplementation ? "Allowing edits…" : "Allow edits"}
                  </button>
                )}
              </div>
              <MessageActions message={message} retrying={retrying} retryDisabled={retryDisabled}
                onRetry={message.id === retryId ? () => void retry(message.id, message.text) : undefined} />
            </article>
          );
        }), [retry, retryDisabled, retryId, retrying, agent.id, agent.messages, agent.canCancel, agent.queueDepth, approveImplementation, approvingImplementation, archived, blocked, hiddenMessages, onApproveImplementation, onResolveCommandApproval, repositoryScope]);

  const headerStatus = archived ? "Archived" : agent.lifecycleBusy ? "Updating…" : statusLabels[agent.status];
  const headerTone = archived || agent.lifecycleBusy ? "idle" : agent.status;
  const showWorkingIndicator = !archived && (headerTone === "working" || agent.canCancel);
  const agentTooltipId = useId();
  const nameTooltip = [
    projectLabel && `Project: ${projectLabel}`,
    repositoryScope && `Repositories: ${repositoryScope.map(({ id }) => id).join(", ")}`,
    taskPhase === "planning" && (repositoryScope ? "Planning · read-only" : "General chat"),
    modelLabel,
    usageLabel,
  ].filter(Boolean).join("\n");

  return (
    <section ref={chat} className="workspace-chat" aria-label={`${recipient} chat`}>
      <header className="chat-header">
        <div className="chat-header-copy">
          {nameDraft !== null ? (
            <form className="chat-rename" onSubmit={rename} onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.stopPropagation();
              if (!renaming) closeRename();
            }}>
              <input ref={renameInput} aria-label="Agent name" value={nameDraft} maxLength={60} required
                aria-invalid={Boolean(renameError)} aria-describedby={renameError ? renameErrorId : undefined}
                readOnly={renaming} onChange={(event) => {
                  setNameDraft(event.target.value);
                  setRenameError("");
                }} />
              <button type="submit" disabled={!nameDraft.trim() || renaming || agent.lifecycleBusy}>Save</button>
              <button type="button" disabled={renaming} onClick={closeRename}>Cancel</button>
              {renameError && <span className="chat-rename-error" id={renameErrorId} role="alert">{renameError}</span>}
            </form>
          ) : <>
            <h2 ref={title} className="chat-agent-title" tabIndex={0} aria-describedby={agentTooltipId}>
              <span className="chat-agent-name">{displayName}</span>
              <span className="chat-agent-divider" aria-hidden="true">|</span>
              <span className="chat-agent-status" data-status={headerTone}>{headerStatus.toLowerCase()}</span>
            </h2>
            <div className="chat-agent-tooltip" id={agentTooltipId} role="tooltip">
              <strong>{displayName}</strong>
              {nameTooltip && <span>{nameTooltip}</span>}
            </div>
          </>}
        </div>
        <div ref={actions} className="chat-lifecycle-menu">
          <button ref={actionsButton} className="interface-icon-button" type="button" aria-label="More actions"
            title="More actions" aria-expanded={actionsOpen} aria-controls={actionsId}
            onClick={() => setActionsOpen((open) => !open)}>
            <LuEllipsis aria-hidden="true" strokeWidth={1.5} />
          </button>
          <div id={actionsId} hidden={!actionsOpen}>
            {onRename && <button type="button" disabled={agent.lifecycleBusy || editingName} onClick={() => {
              setActionsOpen(false);
              setNameDraft(agent.name);
            }}>Rename</button>}
            <button type="button" onClick={() => {
              setActionsOpen(false);
              actionsButton.current?.focus();
              setHiddenMessages(new Set(agent.messages
                .filter((message) => !needsUserInput(message))
                .map((message) => message.id)));
              pinToBottom.current = true;
            }}>Clear chat</button>
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
      {agent.nativeChild && <div className="chat-native-child">
        <span>Read-only subagent transcript.</span>
        {agent.parentId && <button className="chat-steer" type="button"
          onClick={() => onOpenAgent?.(agent.parentId!)}>Open parent conversation</button>}
      </div>}
      {archived && <p className="chat-archive-notice">Archived {new Date(agent.archivedAt!).toLocaleString()}. Restore to continue this conversation.</p>}
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
          {taskDetail && !shownInConversation(taskDetail) && <p className="chat-task-detail" role="status">{taskDetail}</p>}
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
        </div>
        <InlineCodeCopy transcript={transcript} />
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
        {agent.queueDepth > 0 || showWorkingIndicator ? (
          <div className="chat-queue" aria-live="polite">
            {showWorkingIndicator && <OrbitSpinner />}
            {agent.queueDepth > 0 ? `${agent.queueDepth} queued${agent.queuePaused ? " · paused" : ""}`
              : agent.reconnecting ? (/^reconnecting/i.test(agent.reconnecting) ? agent.reconnecting : `Reconnecting… ${agent.reconnecting}`)
              : agent.awaitingSubagents ? `Waiting for ${agent.awaitingSubagents} subagent${agent.awaitingSubagents === 1 ? "" : "s"} — your messages reach the agent now.`
              : steerAction ? "Agent is working — sending will steer the current turn." : "Agent is working — new messages will queue."}
            {agent.queuePaused && onResumeQueue && <button className="chat-steer" type="button"
              disabled={blocked || resumingQueue} onClick={() => void resumeQueue()}>Resume queue</button>}
          </div>
        ) : null}
        {blocked && disabledReason && !shownInConversation(disabledReason) ? <p className="chat-disabled">{disabledReason}</p> : null}
        {!blocked && providerNotice ? <p className="chat-disabled chat-provider-notice" role="status">{providerNotice}
          {retryId && <button type="button" className="chat-steer" disabled={retryDisabled}
            onClick={() => {
              const failed = agent.messages.find(({ id }) => id === retryId);
              if (failed) void retry(failed.id, failed.text);
            }}>{retrying ? "Trying again…" : "Try again"}</button>}</p> : null}
        {error && !shownInConversation(error) ? <p className="chat-error" role="alert">{error}</p> : null}
        <div className="chat-composer-box">
          <div className="chat-composer-input">
            <span className="chat-input-prompt" aria-hidden="true">&gt;</span>
            <textarea aria-label={`Message ${recipient}`} enterKeyHint="send"
              placeholder={repositoryScope?.length ? "Ask a question or describe a change" : "Message the agent"} rows={2}
              disabled={Boolean(agent.lifecycleBusy)} value={draft}
              onChange={(event) => updateDraft(event.target.value)} onBlur={flushDraft} onKeyDown={handleComposerKey} />
          </div>
          <div className="chat-composer-actions">
            {onSteer && <label className="chat-steer-toggle">
              <input type="checkbox" role="switch" aria-label="Steer active turn" checked={steerEnabled}
                onChange={(event) => setSteerEnabled(event.target.checked)} />
              <span aria-hidden="true">{steerEnabled ? "Steer" : "Queue"}</span>
            </label>}
            {showWorkingIndicator ? (
              <button className="chat-send-button" type="button" disabled={blocked || cancelling || !agent.canCancel || !onCancel}
                aria-label={cancelling ? "Stopping current turn" : "Stop current turn"}
                title={cancelling ? "Stopping current turn" : "Stop current turn"}
                onClick={() => void cancelTurn()}>
                <LuSquare className="chat-stop-icon" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
              </button>
            ) : (
              <button className="chat-send-button" type="submit" disabled={!readyToSend}
                aria-label="Send message" title="Send message">
                <LuArrowUp strokeWidth={1.5} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
      </>}
    </section>
  );
}

export function WorkspaceChat(props: ChatProps) {
  return <Conversation key={props.agent.id} {...props} />;
}
