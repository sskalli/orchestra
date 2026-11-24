import { LuArchive, LuMessageSquare, LuMessageSquareDot, LuPlus } from "react-icons/lu";
import { agentAppearance } from "./workspace-agent-appearance.ts";
import { effectiveAgentStatus, needsUserInput } from "./workspace-status.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceCanvas } from "./workspace-canvas.tsx";
import { WorkspaceChat } from "./workspace-chat.tsx";
import { WorkspaceInbox } from "./workspace-inbox.tsx";
import type { InboxEvent } from "./workspace-inbox.tsx";
import { clearFlightLog, recordFlightLog } from "./workspace-flight-log.ts";
import { workspacePreferences } from "./workspace-preferences.ts";
import { useDockResizing } from "./use-dock-resizing.tsx";
import { TaskLifecycleDialog } from "./workspace-task-dialogs.tsx";
import { NewSessionComposer } from "./workspace-new-session.tsx";
import type { AgentSignal, WorkspaceRuntime } from "./workspace-runtime.ts";
import { createTask, send } from "./workspace-commands.ts";
import "./workspace.css";

type Snapshot = ReturnType<WorkspaceRuntime["snapshot"]>;
type UsageTotals = NonNullable<Snapshot["usage"]>["total"];
type Agent = Snapshot["agents"][number];
type Activity = { agent: Agent; messageId?: string; text: string };

const formatTokens = new Intl.NumberFormat().format;

function usageLabel(usage: UsageTotals | undefined, label: string) {
  if (!usage?.tokens) return `${label}: Unknown`;
  const partial = usage.partialTurns > 0 || usage.unknownTurns > 0;
  return `${label}: ${formatTokens(usage.tokens.totalTokens)}${partial ? " (partial)" : ""}`;
}

function WorkspaceUsage({ usage }: { usage: NonNullable<Snapshot["usage"]> }) {
  const { tokens, observedTurns, partialTurns, unknownTurns } = usage.total;
  return <details className="sw-usage-menu">
    <summary>Token usage</summary>
    <div className="sw-usage-details" role="region" aria-label="Workspace token usage">
      <strong>{usageLabel(usage.total, "Workspace tokens")}</strong>
      <p>{observedTurns + partialTurns + unknownTurns === 0 ? "No turns recorded" : [
        `${formatTokens(observedTurns)} measured`,
        partialTurns > 0 && `${formatTokens(partialTurns)} partial`,
        unknownTurns > 0 && `${formatTokens(unknownTurns)} unknown`,
        "turn coverage",
      ].filter(Boolean).join(" · ")}</p>
      {tokens && <dl>
        <dt>Input</dt><dd>{formatTokens(tokens.inputTokens)}</dd>
        <dt>Cached input</dt><dd>{formatTokens(tokens.cachedInputTokens)}</dd>
        {tokens.cacheWriteInputTokens !== undefined && <>
          <dt>Cache write</dt><dd>{formatTokens(tokens.cacheWriteInputTokens)}</dd>
        </>}
        <dt>Output</dt><dd>{formatTokens(tokens.outputTokens)}</dd>
        <dt>Reasoning output</dt><dd>{formatTokens(tokens.reasoningOutputTokens)}</dd>
        {usage.unattributedTokens && <>
          <dt>Unattributed</dt><dd>{formatTokens(usage.unattributedTokens.totalTokens)}</dd>
        </>}
      </dl>}
      {usage.issue
        ? <p className="sw-usage-issue" role="status">{usage.issue}</p>
        : <a href="/api/usage" download="orchestra-usage.json">Download usage JSON</a>}
    </div>
  </details>;
}

function providerLabel({ state }: Snapshot["provider"]) {
  return {
    demo: "Demo mode",
    connecting: "Connecting to Codex",
    ready: "Codex connected",
    "signed-out": "Codex sign-in required",
    error: "Codex unavailable",
    "usage-limit": "Codex usage limit",
  }[state];
}

function Mark() {
  return <svg className="sw-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"
    aria-hidden="true" focusable="false">
    <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(30 12 12)" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
  </svg>;
}

function Folder() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1M3 7v11a1 1 0 0 0 1 1h14.5a1 1 0 0 0 1-.8l2.1-7a1 1 0 0 0-1-1.2H7a1 1 0 0 0-1 .8L4 18" /></svg>;
}

function attention(agent: Agent): Activity[] {
  const requests = agent.messages.flatMap((message) => needsUserInput(message)
    ? [{ agent, messageId: message.id, text: message.text.split("\n", 1)[0].slice(0, 160) }] : []);
  if (requests.length) return requests;
  if (agent.status === "attention" || agent.status === "error") {
    const message = agent.messages.findLast((entry) => entry.state === "failed" || entry.role === "system");
    return [{ agent, messageId: message?.id, text: message?.text ?? (agent.status === "error" ? "Run failed" : "Needs your response") }];
  }
  return [];
}

function activityFor(agents: Agent[], id: string) {
  const ids = new Set([id]);
  let size = 0;
  while (size !== ids.size) {
    size = ids.size;
    for (const agent of agents) {
      if (agent.parentId && ids.has(agent.parentId)) ids.add(agent.id);
    }
  }
  return agents.filter((agent) => !agent.archivedAt && ids.has(agent.id)).flatMap(attention);
}

const inboxStatus = {
  idle: ["Idle", "notice"], working: ["Working", "working"], attention: ["Needs attention", "attention"],
  "awaiting-confirmation": ["Ready for review", "notice"], done: ["Complete", "done"],
  error: ["Failed", "error"], notice: ["Update available", "notice"],
} as const;

function flightLogEvents(agents: Agent[]): InboxEvent[] {
  const activeAgents = agents.filter((agent) => !agent.archivedAt);
  const activeIds = new Set(activeAgents.map(({ id }) => id));
  return activeAgents.filter((agent) => !agent.parentId || !activeIds.has(agent.parentId)).flatMap((root) => {
    const agentName = root.name;
    const actions = activityFor(agents, root.id);
    if (actions.length) return actions.map(({ agent, messageId, text }) => {
      const [status, tone] = inboxStatus[agent.status];
      const source = agent.messages.find(({ id }) => id === messageId);
      return { id: `${root.id}:${agent.id}:${messageId ?? "status"}`, agentName,
        status: tone === "error" ? status : "Needs attention", tone: tone === "error" ? tone : "attention",
        text: source?.text ?? text, agentId: agent.id, messageId,
        needsInput: source ? needsUserInput(source) : false };
    });
    const [status, tone] = inboxStatus[root.status];
    const message = root.messages.findLast((entry) => entry.role !== "user" && !entry.state);
    return [{ id: root.id, agentName, status, tone,
      text: message?.text ?? root.goal ?? "Open the conversation for details.",
      agentId: root.id, messageId: message?.id }];
  });
}

function Workspace() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [connected, setConnected] = useState(false);
  const [signals, setSignals] = useState<AgentSignal[]>([]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    const timers = new Set<ReturnType<typeof setTimeout>>();
    events.onerror = () => setConnected(false);
    events.onmessage = ({ data }) => {
      setSnapshot(JSON.parse(data) as Snapshot);
      setConnected(true);
    };
    events.addEventListener("agent-signal", (event) => {
      const signal = JSON.parse((event as MessageEvent).data) as AgentSignal;
      setSignals((current) => [...current.slice(-39), signal]);
      const timer = setTimeout(() => {
        setSignals((current) => current.filter((entry) => entry.id !== signal.id));
        timers.delete(timer);
      }, 350);
      timers.add(timer);
    });
    return () => {
      events.close();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  if (!snapshot) {
    return <main className="sw-loading"><Mark /><span>Connecting to Orchestra…</span></main>;
  }

  const mode = snapshot.provider.state === "demo" ? "demo" : "codex";
  return <WorkspaceView key={JSON.stringify([snapshot.workspaceKey, mode, snapshot.modelProvider])} snapshot={snapshot} connected={connected} mode={mode} signals={signals} />;
}

function WorkspaceView({ snapshot, connected, mode, signals }: { snapshot: Snapshot; connected: boolean; mode: "demo" | "codex"; signals: AgentSignal[] }) {
  const { project, provider } = snapshot;
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  useEffect(() => {
    const onFailure = () => setStorageUnavailable(true);
    window.addEventListener("orchestra-storage-unavailable", onFailure);
    return () => window.removeEventListener("orchestra-storage-unavailable", onFailure);
  }, []);
  const agents = useMemo(() => snapshot.agents.map((agent) => ({ ...agent, status: effectiveAgentStatus(agent) })), [snapshot.agents]);
  const [preferences] = useState(() => workspacePreferences(snapshot.workspaceKey, mode, snapshot.modelProvider));
  const [saved] = useState(preferences.readView);
  const [savedCamera] = useState(preferences.readCamera);
  const [composerSizes, setComposerSizes] = useState(preferences.readComposers);
  const composerSizesRef = useRef(composerSizes);
  const [leftOpen, setLeftOpen] = useState(saved.leftOpen);
  const [inboxReadSequence, setInboxReadSequence] = useState(preferences.readInboxReadSequence);
  const [flightLog, setFlightLog] = useState(preferences.readFlightLog);
  const [selectedId, setSelectedId] = useState(saved.selectedId);
  const [dockId, setDockId] = useState(saved.selectedId);
  const [drafts, setDrafts] = useState(saved.drafts);
  const draftsRef = useRef(saved.drafts);
  const draftRevisions = useRef<Record<string, number>>({});
  const [focus, setFocus] = useState<{ id?: string; count: number }>({ count: 0 });
  const [chooser, setChooser] = useState<{ agentId: string }>();
  const [projectDetails, setProjectDetails] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const chatOpen = newTaskOpen || agents.some((agent) => agent.id === selectedId);
  const { bodyRef, resizing, style: dockStyle, resizeHandle } =
    useDockResizing(preferences, leftOpen, chatOpen);
  const [newTaskId, setNewTaskId] = useState<string>();
  const [lifecycle, setLifecycle] = useState<{ action: "archive" | "restore" | "delete"; agentId: string }>();
  const chatWindowRef = useRef<HTMLElement>(null);
  const archivedToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      document.querySelectorAll<HTMLDetailsElement>(".sw-usage-menu[open]").forEach((menu) => {
        if (!menu.contains(target)) menu.open = false;
      });
      if (!target.closest(".sw-project-menu")) setProjectDetails(false);
      if (!target.closest(".sw-archive-list, .sw-archived-toggle")) setArchiveOpen(false);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : undefined;
      const menu = target?.closest<HTMLDetailsElement>(".sw-usage-menu[open]") ??
        document.querySelector<HTMLDetailsElement>(".sw-usage-menu[open]");
      const projectTrigger = document.querySelector<HTMLButtonElement>(".sw-project-button[aria-expanded='true']");
      if (menu) {
        menu.open = false;
        menu.querySelector("summary")?.focus();
        event.stopPropagation();
      } else if (projectTrigger) {
        setProjectDetails(false);
        projectTrigger.focus();
        event.stopPropagation();
      } else if (archivedToggle.current?.getAttribute("aria-expanded") === "true") {
        setArchiveOpen(false);
        archivedToggle.current?.focus();
        event.stopPropagation();
      }
    };
    // Capture also catches clicks that map gestures or dock controls handle locally.
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("click", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, []);

  useEffect(() => {
    if (!newTaskId) return;
    if (!newTaskOpen) {
      setNewTaskId(undefined);
      return;
    }
    if (!snapshot.agents.some((agent) => agent.id === newTaskId)) return;
    setNewTaskOpen(false);
    setSelectedId(newTaskId);
    setDockId(newTaskId);
    setChooser(undefined);
    setFocus((previous) => ({ count: previous.count + 1 }));
    setNewTaskId(undefined);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".sw-right textarea")?.focus());
  }, [snapshot.agents, newTaskId, newTaskOpen]);

  useEffect(() => {
    if (selectedId && !snapshot.agents.some((agent) => agent.id === selectedId)) {
      setSelectedId(null);
      setDockId(null);
    }
  }, [snapshot.agents, selectedId]);

  useEffect(() => {
    preferences.writeView({ leftOpen, selectedId, drafts: draftsRef.current });
  }, [preferences, leftOpen, selectedId, drafts]);

  useEffect(() => {
    const persist = () => preferences.writeView({ leftOpen, selectedId, drafts: draftsRef.current });
    window.addEventListener("pagehide", persist);
    return () => window.removeEventListener("pagehide", persist);
  }, [preferences, leftOpen, selectedId]);

  const selected = agents.find((agent) => agent.id === selectedId);
  const dockAgent = agents.find((agent) => agent.id === dockId);
  const blocked = !connected || !["ready", "demo"].includes(provider.state);
  const blockedReason = !connected ? "Reconnecting to the local workspace…" : provider.message ?? providerLabel(provider);
  const projectName = project.name;

  const inboxEvents = useMemo(() => flightLogEvents(agents), [agents]);

  const pendingInboxQuestions = inboxEvents.filter(({ needsInput }) => needsInput);
  const pendingQuestionIds = new Set(pendingInboxQuestions.map(({ id }) => id));
  const activeConversations = new Map(agents.filter((agent) => !agent.archivedAt).map((agent) => [agent.id, agent]));
  const logEvents = flightLog.entries.flatMap(({ sequence, event }) => {
    const conversation = activeConversations.get(event.agentId);
    if (!conversation) return [];
    let owner = conversation;
    const visited = new Set([owner.id]);
    while (owner.parentId && !visited.has(owner.parentId)) {
      const parent = activeConversations.get(owner.parentId);
      if (!parent) break;
      owner = parent;
      visited.add(owner.id);
    }
    const source = conversation.messages.find(({ id }) => id === event.messageId);
    const text = source?.text ?? inboxEvents.find(({ id }) => id === event.id)?.text ?? event.status;
    return [{ ...event, id: String(sequence), agentName: agentAppearance(owner).displayName, text: text.length > 500 ? text.slice(0, 499) + "…" : text }];
  });
  const canClearLog = flightLog.entries.some(({ event }) =>
    activeConversations.has(event.agentId) && !pendingQuestionIds.has(event.id));

  useEffect(() => preferences.subscribeFlightLog(setFlightLog), [preferences]);

  useEffect(() => {
    if (!connected || provider.state === "connecting" || (provider.state === "error" && !agents.length)) return;
    let active = true;
    void preferences.updateFlightLog((previous) => active ? recordFlightLog(previous, inboxEvents, agents) : previous)
      .then((next) => { if (active) setFlightLog(next); });
    return () => { active = false; };
  }, [agents, connected, inboxEvents, preferences, provider.state]);

  async function clearLog() {
    const next = await preferences.updateFlightLog((previous) => clearFlightLog(previous, pendingQuestionIds));
    setFlightLog(next);
  }

  const hasUnreadNotifications = flightLog.entries.some(({ sequence, event }) =>
    sequence > inboxReadSequence && activeConversations.has(event.agentId));
  const hasUnresolvedRequest = agents.some((agent) => !agent.archivedAt &&
    (agent.status === "attention" || agent.status === "awaiting-confirmation" || agent.directTask?.phase === "ready-for-review"));
  const inboxHasActivity = hasUnreadNotifications || hasUnresolvedRequest;

  useEffect(() => {
    if (!leftOpen || flightLog.sequence === inboxReadSequence) return;
    setInboxReadSequence(flightLog.sequence);
    preferences.writeInboxReadSequence(flightLog.sequence);
  }, [leftOpen, flightLog.sequence, inboxReadSequence, preferences]);

  function select(id: string | null, messageId?: string) {
    setNewTaskOpen(false);
    setSelectedId(id);
    if (id) setDockId(id);
    setChooser(undefined);
    setFocus((previous) => ({ id: messageId, count: previous.count + 1 }));
  }

  function dismissNewTask() {
    setNewTaskOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="New session"]')?.focus());
  }

  function closeAgent(restoreFocus: boolean) {
    const node = restoreFocus && selectedId ? document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(selectedId)}"]`) : undefined;
    select(null);
    node?.focus({ preventScroll: true });
  }

  function handleStatus(id: string) {
    const events = activityFor(agents, id);
    if (events.length > 1) {
      setChooser({ agentId: id });
      return;
    }
    if (events.length) {
      select(events[0].agent.id, events[0].messageId);
      return;
    }
    const agent = agents.find((item) => item.id === id);
    select(id, agent?.messages.findLast((message) => message.role !== "user")?.id);
  }

  function toggleInbox(open: boolean) {
    setLeftOpen(open);
    requestAnimationFrame(() => {
      const label = open ? "Minimize agent inbox" : "Open agent inbox";
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.focus();
    });
  }

  const canvasAgents = agents.filter((agent) => !agent.archivedAt).map((agent) => ({
    ...agent,
    projectLabel: snapshot.projects.length > 1
      ? agent.directTask?.projectIds.join(", ") || agent.projectId
      : undefined,
  }));
  const archivedAgents = agents.filter((agent) => agent.archivedAt);

  function subtree(id: string) {
    const ids = new Set([id]);
    let previous = 0;
    while (previous !== ids.size) {
      previous = ids.size;
      for (const agent of agents) if (agent.parentId && ids.has(agent.parentId)) ids.add(agent.id);
    }
    return agents.filter((agent) => ids.has(agent.id));
  }

  function requestLifecycle(action: "archive" | "restore" | "delete", agentId: string) {
    setLifecycle({ action, agentId });
  }

  const lifecycleAgent = agents.find((agent) => agent.id === lifecycle?.agentId);
  const affected = lifecycleAgent ? subtree(lifecycleAgent.id) : [];
  const hasRunning = affected.some((agent) => agent.status === "working" || agent.status === "attention" || agent.lifecycleBusy);

  async function applyLifecycle() {
    if (!lifecycle) return;
    const { action, agentId } = lifecycle;
    await send(action === "archive"
      ? { type: "archive", agentId, stopRunning: hasRunning }
      : { type: action, agentId });

    if (action === "delete") {
      const ids = new Set(affected.map((agent) => agent.id));
      draftsRef.current = Object.fromEntries(Object.entries(draftsRef.current).filter(([id]) => !ids.has(id)));
      setDrafts(draftsRef.current);
      if (selectedId && ids.has(selectedId)) select(null);
      requestAnimationFrame(() => archivedToggle.current?.focus());
    }
  }

  function renderChat(agent: Agent) {
    const repositories = agent.directTask?.projectIds.map((id) => ({
      id,
      path: snapshot.projects.find((project) => project.id === id)?.path,
    }));

    async function submit(type: "send" | "steer", value: string) {
      const revision = draftRevisions.current[agent.id] ?? 0;
      await send({ type, agentId: agent.id, text: value });
      if ((draftRevisions.current[agent.id] ?? 0) === revision) {
        draftsRef.current = { ...draftsRef.current, [agent.id]: "" };
        setDrafts((current) => (draftRevisions.current[agent.id] ?? 0) === revision && current[agent.id] === value
          ? { ...current, [agent.id]: "" } : current);
      }
    }

    const settings = agent.modelSettings;
    const model = settings?.reportedModel ?? settings?.requestedModel;
    const effort = settings?.reportedEffort;
    const modelLabel = [model, effort && `${effort} effort`].filter(Boolean).join(" · ");

    const usage = snapshot.usage ? usageLabel(snapshot.usage.byAgent[agent.id], "Tokens") : undefined;

    return <WorkspaceChat
      key={agent.id}
      agent={agent}
      onOpenAgent={(id) => select(id)}
      onRename={agent.nativeChild ? undefined : (name) => send({ type: "rename", agentId: agent.id, name })}
      onLifecycle={agent.nativeChild ? undefined : (action) => requestLifecycle(action, agent.id)}
      onApproveImplementation={agent.directTask?.projectIds.length
        ? (requestId) => send({ type: "approveImplementation", agentId: agent.id, requestId })
        : undefined}
      onResolveCommandApproval={agent.directTask && !agent.nativeChild
        ? (requestId, decision) => send({ type: "resolveCommandApproval", agentId: agent.id, requestId, decision })
        : undefined}
      projectLabel={agent.nativeChild && snapshot.projects.length > 1 ? agent.projectId : undefined}
      repositoryScope={repositories?.length ? repositories : undefined}
      taskPhase={agent.directTask?.phase}
      taskDetail={agent.directTask?.detail}
      delivery={agent.integration?.members?.length ? {
        members: agent.integration.members,
        taskChecks: agent.integration.validationEvidence?.summary,
      } : undefined}
      modelLabel={modelLabel}
      usageLabel={usage}
      draft={drafts[agent.id] ?? ""}
      composerHeight={composerSizes.agent}
      onComposerHeightChange={(height) => {
        const next = { ...composerSizesRef.current, agent: height };
        composerSizesRef.current = next;
        preferences.writeComposers(next);
        setComposerSizes(next);
      }}
      onDraftInput={(value) => {
        draftsRef.current = { ...draftsRef.current, [agent.id]: value };
        draftRevisions.current[agent.id] = (draftRevisions.current[agent.id] ?? 0) + 1;
      }}
      onDraftChange={(value) => setDrafts((current) => ({ ...current, [agent.id]: value }))}
      onSend={(value) => submit("send", value)}
      onSteer={(value) => submit("steer", value)}
      onCancel={() => send({ type: "cancel", agentId: agent.id })}
      onResumeQueue={() => send({ type: "resumeQueue", agentId: agent.id })}
      onClose={() => closeAgent(true)}
      disabled={blocked || Boolean(agent.unavailableReason) || Boolean(agent.archivedAt) || Boolean(agent.lifecycleBusy)}
      disabledReason={agent.unavailableReason ?? (blocked && !(connected && provider.state === "usage-limit") ? blockedReason : undefined)}
      focusMessageId={focus.id}
      focusRequest={focus.count}
    />;
  }

  const inboxToggleLabel = leftOpen ? "Hide agent inbox" : "Open agent inbox";
  const InboxIcon = inboxHasActivity ? LuMessageSquareDot : LuMessageSquare;
  const inboxToggle = (
    <button type="button" className={`interface-icon-button sw-inbox-button${leftOpen ? "" : " sw-inbox-toggle"}`}
      aria-label={inboxToggleLabel} title={inboxToggleLabel} aria-expanded={leftOpen}
      aria-controls="workspace-inbox-window" data-inbox-alert={inboxHasActivity}
      onClick={() => toggleInbox(!leftOpen)}>
      <InboxIcon aria-hidden="true" strokeWidth={1.5} />
    </button>
  );

  return (
    <div className="sw-app">
      <header className="sw-header">
        <div className="sw-brand"><Mark /><span>Orchestra</span></div>
        <div className="sw-project-menu" onKeyDown={(event) => {
          if (event.key === "Escape" && projectDetails) {
            event.stopPropagation();
            setProjectDetails(false);
            event.currentTarget.querySelector("button")?.focus();
          }
        }}>
          <button className="sw-project-button" type="button" aria-expanded={projectDetails} aria-controls="workspace-project-list" onClick={() => setProjectDetails(!projectDetails)}><Folder /><span>{projectName}</span><span className="sw-chevron" aria-hidden="true" /></button>
          {projectDetails && <div id="workspace-project-list" className="sw-project-details">
            {snapshot.projects.map((entry) => <div key={entry.id}><strong>{entry.id}</strong><span>{entry.path}</span></div>)}
          </div>}
        </div>
        <div className={`sw-provider sw-provider--${connected ? provider.state : "connecting"}`} role="status"><span aria-hidden="true" />{connected ? providerLabel(provider) : "Reconnecting"}</div>
        {snapshot.usage && <WorkspaceUsage usage={snapshot.usage} />}
      </header>
      <main ref={bodyRef} className={`sw-body ${chatOpen ? "is-agent-open" : ""} ${leftOpen ? "is-inbox-open" : ""} ${resizing ? "is-resizing" : ""}`}
        style={dockStyle}>
        {!leftOpen && inboxToggle}
        <aside id="workspace-inbox-window" className="sw-dock sw-left" aria-label="Inbox window" hidden={!leftOpen}>
          <div className="sw-dock-inner">
            <WorkspaceInbox toggle={leftOpen ? inboxToggle : undefined} events={logEvents} onOpen={select} onClose={() => toggleInbox(false)}
              onClear={clearLog}
              canClear={canClearLog} />
          </div>
          {leftOpen && <>
            {resizeHandle("left")}
            {resizeHandle("bottom")}
            {resizeHandle("corner")}
          </>}
        </aside>
        <section className="sw-canvas">
          <div className="sw-map-actions">
            <button ref={archivedToggle} className="sw-map-action sw-archived-toggle" type="button" aria-expanded={archiveOpen}
              aria-label={`Archived (${archivedAgents.length})`} title={`Archived (${archivedAgents.length})`}
              onClick={() => setArchiveOpen(!archiveOpen)}><LuArchive aria-hidden="true" /></button>
            {mode === "codex" && !blocked && <button className="sw-map-action" type="button"
              aria-label="New session" title="New session" onClick={() => setNewTaskOpen(true)}>
              <LuPlus aria-hidden="true" />
            </button>}
          </div>
          {(blocked || storageUnavailable) && <div className="sw-banner" role="status">{blocked ? blockedReason : "Browser storage is unavailable. Drafts and layout changes may not survive reload."}</div>}
          <WorkspaceCanvas agents={canvasAgents} signals={signals} selectedId={selectedId} onSelect={select} onStatus={handleStatus}
            chatWindowRef={chatWindowRef} initialCamera={savedCamera} onCameraChange={preferences.writeCamera} />
          {archiveOpen && <section className="sw-archive-list" aria-label="Archived agents" onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setArchiveOpen(false); archivedToggle.current?.focus(); }
          }}>
            <header><strong>Archived agents</strong><button type="button" aria-label="Close archived agents" onClick={() => { setArchiveOpen(false); archivedToggle.current?.focus(); }}>×</button></header>
            {!archivedAgents.length && <p>No archived agents.</p>}
            {archivedAgents.map((agent) => {
              const parent = agents.find((entry) => entry.id === agent.parentId);
              return <article key={agent.id}>
                <button type="button" onClick={() => { select(agent.id); setArchiveOpen(false); }}>{agentAppearance(agent).displayName}</button>
                {parent && <small>Parent: {agentAppearance(parent).displayName}</small>}
                {agent.directTask?.projectIds.length ? <small>Repositories: {agent.directTask.projectIds.join(", ")}</small> : null}
                <small>Archived {new Date(agent.archivedAt!).toLocaleString()}</small>
                {!agent.nativeChild && <div><button type="button" disabled={!connected || agent.lifecycleBusy} onClick={() => requestLifecycle("restore", agent.id)}>Restore</button>
                  <button type="button" disabled={!connected || agent.lifecycleBusy} onClick={() => requestLifecycle("delete", agent.id)}>Delete permanently…</button></div>}
              </article>;
            })}
          </section>}
          {chooser && <div className="sw-activity" role="dialog" aria-label="Events needing attention" onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setChooser(undefined); }
          }}>
            <header><strong>Needs attention</strong><button type="button" aria-label="Close events" onClick={() => setChooser(undefined)}>×</button></header>
            {activityFor(agents, chooser.agentId).map((event, index) => <button key={`${event.agent.id}:${event.messageId}`} type="button" autoFocus={index === 0} onClick={() => select(event.agent.id, event.messageId)}><strong>{snapshot.projects.length > 1 && event.agent.projectId ? `${event.agent.projectId} / ` : ""}{agentAppearance(event.agent).displayName}</strong><span>{event.text}</span></button>)}
          </div>}
        </section>
        <aside ref={chatWindowRef} className="sw-dock sw-right" aria-label={newTaskOpen ? "Session composer" : "Agent chat"}
          inert={!selected && !newTaskOpen} onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (!newTaskOpen) closeAgent(true);
          }}>
          <div className="sw-dock-inner">
            <div className="sw-conversation" hidden={newTaskOpen}>{dockAgent && renderChat(dockAgent)}</div>
            <NewSessionComposer open={newTaskOpen} blocked={blocked} projects={snapshot.projects}
              onCancel={dismissNewTask} onCreate={createTask}
              onSend={(agentId, text) => send({ type: "send", agentId, text })}
              onStarted={setNewTaskId} />
          </div>
          {(selected || newTaskOpen) && resizeHandle("right")}
        </aside>
      </main>
      <TaskLifecycleDialog action={lifecycle?.action}
        agentName={lifecycleAgent && agentAppearance(lifecycleAgent).displayName}
        affectedCount={affected.length} hasRunning={hasRunning} connected={connected}
        onDismiss={() => setLifecycle(undefined)} onConfirm={applyLifecycle} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Workspace />);
