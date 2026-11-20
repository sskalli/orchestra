import { agentAppearance, numberAgentRoles } from "./workspace-agent-appearance.ts";
import { effectiveAgentStatus } from "./workspace-status.ts";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceCanvas } from "./workspace-canvas.tsx";
import { WorkspaceChat } from "./workspace-chat.tsx";
import { workspacePreferences } from "./workspace-preferences.ts";
import type { PanelSizes } from "./workspace-preferences.ts";
import type { AgentSignal, WorkspaceRuntime } from "./workspace-runtime.ts";
import "./workspace.css";

type Snapshot = ReturnType<WorkspaceRuntime["snapshot"]>;
type UsageTotals = NonNullable<Snapshot["usage"]>["total"];
type Agent = Snapshot["agents"][number] & { roleNumber: number };
type Command = Parameters<WorkspaceRuntime["command"]>[0];
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

function providerLabel({ name, state }: Snapshot["provider"]) {
  const title = name === "claude" ? "Claude Code" : "Codex";
  return {
    demo: "Demo mode",
    connecting: `Connecting to ${title}`,
    ready: `${title} connected`,
    "signed-out": `${title} sign-in required`,
    error: `${title} unavailable`,
    "usage-limit": `${title} usage limit`,
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
  const pending = agent.messages.filter((message) => message.approval?.state === "pending");
  if (pending.length) return pending.map((message) => ({
    agent, messageId: message.id, text: message.text.split("\n", 1)[0].slice(0, 160),
  }));
  if (agent.status === "attention" || agent.status === "error") {
    const message = agent.messages.findLast((entry) => entry.state === "failed" || entry.role === "system");
    return [{ agent, messageId: message?.id, text: message?.text ?? (agent.status === "error" ? "Run failed" : "Needs your response") }];
  }
  return [];
}

async function send(command: Command) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "The workspace could not accept that command");
  }
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

  const mode = snapshot.provider.state === "demo" ? "demo" : snapshot.provider.name;
  return <WorkspaceView key={JSON.stringify([snapshot.workspaceKey, mode, snapshot.modelProvider])} snapshot={snapshot} connected={connected} mode={mode} signals={signals} />;
}

function WorkspaceView({ snapshot, connected, mode, signals }: { snapshot: Snapshot; connected: boolean; mode: "demo" | Snapshot["provider"]["name"]; signals: AgentSignal[] }) {
  const { project, provider } = snapshot;
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  useEffect(() => {
    const onFailure = () => setStorageUnavailable(true);
    window.addEventListener("orchestra-storage-unavailable", onFailure);
    return () => window.removeEventListener("orchestra-storage-unavailable", onFailure);
  }, []);
  const agents = numberAgentRoles(snapshot.agents.map((agent) => ({ ...agent, status: effectiveAgentStatus(agent) })));
  const [preferences] = useState(() => workspacePreferences(snapshot.workspaceKey, mode, snapshot.modelProvider));
  const [saved] = useState(preferences.readView);
  const [savedCamera] = useState(preferences.readCamera);
  const [panelSizes, setPanelSizes] = useState(preferences.readPanels);
  const [composerSizes, setComposerSizes] = useState(preferences.readComposers);
  const composerSizesRef = useRef(composerSizes);
  const panelSizesRef = useRef(panelSizes);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 650px)").matches);
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ pointerId: number; start: number; size: number; side: "left" | "right"; vertical: boolean } | null>(null);
  const [panelMetrics, setPanelMetrics] = useState({ width: 0, height: 0, left: 0, right: 0, leftHeight: 0 });
  const panelMetricsRef = useRef(panelMetrics);
  const resizeFrame = useRef<number | null>(null);
  const pendingResize = useRef<{ key: keyof PanelSizes; value: number; handle: HTMLDivElement } | null>(null);
  const [leftOpen, setLeftOpen] = useState(saved.leftOpen);
  const [selectedId, setSelectedId] = useState(saved.selectedId);
  const [dockId, setDockId] = useState(saved.selectedId);
  const [drafts, setDrafts] = useState(saved.drafts);
  const draftsRef = useRef(saved.drafts);
  const draftRevisions = useRef<Record<string, number>>({});
  const [focus, setFocus] = useState<{ id?: string; count: number }>({ count: 0 });
  const [chooser, setChooser] = useState<{ agentId: string }>();
  const [projectDetails, setProjectDetails] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<{ action: "archive" | "restore" | "delete"; agentId: string }>();
  const [lifecycleError, setLifecycleError] = useState("");
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const lifecycleDialog = useRef<HTMLDialogElement>(null);
  const archivedToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      document.querySelectorAll<HTMLDetailsElement>(".chat-lifecycle-menu[open], .sw-usage-menu[open]").forEach((menu) => {
        if (!menu.contains(target)) menu.open = false;
      });
      if (!target.closest(".sw-project-menu")) setProjectDetails(false);
      if (!target.closest(".sw-archive-list, .sw-archived-toggle")) setArchiveOpen(false);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : undefined;
      const menu = target?.closest<HTMLDetailsElement>(".chat-lifecycle-menu[open], .sw-usage-menu[open]") ??
        document.querySelector<HTMLDetailsElement>(".chat-lifecycle-menu[open], .sw-usage-menu[open]");
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
    if (lifecycle) lifecycleDialog.current?.showModal();
    else lifecycleDialog.current?.close();
  }, [lifecycle]);

  useEffect(() => {
    if (selectedId && !snapshot.agents.some((agent) => agent.id === selectedId)) {
      setSelectedId(null);
      setDockId(null);
    }
  }, [snapshot.agents, selectedId]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 650px)");
    const update = () => {
      flushResize();
      if (resizeRef.current) setPanelSizes(panelSizesRef.current);
      resizeRef.current = null;
      setResizing(false);
      setMobile(media.matches);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => preferences.writePanels(panelSizes), 200);
    return () => clearTimeout(timer);
  }, [panelSizes, preferences]);

  useEffect(() => {
    const persist = () => preferences.writePanels(panelSizesRef.current);
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
      persist();
    };
  }, [preferences]);

  useEffect(() => {
    const body = bodyRef.current;
    const left = body?.querySelector<HTMLElement>(".sw-left");
    const right = body?.querySelector<HTMLElement>(".sw-right");
    if (!body || !left || !right) return;
    const measure = () => {
      const bounds = body.getBoundingClientRect();
      const leftBounds = left.getBoundingClientRect();
      const rightBounds = right.getBoundingClientRect();
      const next = { width: bounds.width, height: bounds.height, left: leftBounds.width, right: rightBounds.width, leftHeight: leftBounds.height };
      panelMetricsRef.current = next;
      if (resizeRef.current) return;
      setPanelMetrics((current) => Object.keys(next).every((key) =>
        current[key as keyof typeof current] === next[key as keyof typeof next]) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(left);
    observer.observe(right);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    preferences.writeView({ leftOpen, selectedId, drafts: draftsRef.current });
  }, [preferences, leftOpen, selectedId, drafts]);

  useEffect(() => {
    const persist = () => preferences.writeView({ leftOpen, selectedId, drafts: draftsRef.current });
    window.addEventListener("pagehide", persist);
    return () => window.removeEventListener("pagehide", persist);
  }, [preferences, leftOpen, selectedId]);

  const projectAgent = agents.find((agent) => agent.role === "coordinator");
  const selected = agents.find((agent) => agent.id === selectedId);
  const dockAgent = agents.find((agent) => agent.id === dockId);
  const blocked = !connected || !["ready", "demo"].includes(provider.state);
  const blockedReason = !connected ? "Reconnecting to the local workspace…" : provider.message ?? providerLabel(provider);
  const projectName = project.name;

  function activityFor(id: string) {
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

  function select(id: string | null, messageId?: string) {
    setSelectedId(id);
    if (id) setDockId(id);
    setChooser(undefined);
    setFocus((previous) => ({ id: messageId, count: previous.count + 1 }));
  }

  function closeAgent(restoreFocus: boolean) {
    const node = restoreFocus && selectedId ? document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(selectedId)}"]`) : undefined;
    select(null);
    node?.focus();
  }

  function handleStatus(id: string) {
    const events = activityFor(id);
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

  function toggleProjectChat(open: boolean) {
    setLeftOpen(open);
    requestAnimationFrame(() => {
      const label = open ? "Collapse project chat" : "Expand project chat";
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.focus();
    });
  }

  function panelBounds(side: "left" | "right") {
    const vertical = mobile && side === "left";
    const metrics = panelMetricsRef.current;
    const length = vertical ? metrics.height : metrics.width;
    const current = vertical ? metrics.leftHeight : metrics[side];
    const minimum = vertical ? 160 : side === "left" ? 200 : 230;
    const maximum = Math.max(0, vertical ? length - 130 : mobile ? length - 48 : length * 0.44);
    return { min: Math.min(minimum, maximum), max: maximum, current };
  }

  function resizePanel(side: "left" | "right", value: number) {
    const { min, max } = panelBounds(side);
    const key: keyof PanelSizes = mobile && side === "left" ? "mobileLeft" : side;
    const next = { ...panelSizesRef.current, [key]: Math.round(Math.max(min, Math.min(max, value))) };
    panelSizesRef.current = next;
    setPanelSizes(next);
  }

  function flushResize() {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    const pending = pendingResize.current;
    if (!pending) return;
    const property = pending.key === "mobileLeft" ? "--mobile-left-size" : `--${pending.key}-size`;
    bodyRef.current?.style.setProperty(property, `${pending.value}px`);
    pending.handle.setAttribute("aria-valuenow", String(pending.value));
    pendingResize.current = null;
  }

  function resizeHandle(side: "left" | "right") {
    const vertical = mobile && side === "left";
    const { min, max, current } = panelBounds(side);
    const start = (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      const size = panelBounds(side).current;
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = { pointerId: event.pointerId, start: vertical ? event.clientY : event.clientX, size, side, vertical };
      setResizing(true);
    };
    const move = (event: PointerEvent<HTMLDivElement>) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = (drag.vertical ? event.clientY : event.clientX) - drag.start;
      const { min, max } = panelBounds(drag.side);
      const value = Math.round(Math.max(min, Math.min(max,
        drag.size + (drag.side === "right" || drag.vertical ? -distance : distance))));
      const key: keyof PanelSizes = drag.vertical ? "mobileLeft" : drag.side;
      panelSizesRef.current = { ...panelSizesRef.current, [key]: value };
      pendingResize.current = { key, value, handle: event.currentTarget };
      if (resizeFrame.current === null) resizeFrame.current = requestAnimationFrame(flushResize);
    };
    const end = (event: PointerEvent<HTMLDivElement>) => {
      if (resizeRef.current?.pointerId !== event.pointerId) return;
      flushResize();
      resizeRef.current = null;
      setPanelSizes(panelSizesRef.current);
      setPanelMetrics(panelMetricsRef.current);
      setResizing(false);
    };
    const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
      const increment = event.shiftKey ? 50 : 10;
      const direction = vertical ? (event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0)
        : (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0) * (side === "right" ? -1 : 1);
      if (event.key === "Home" || event.key === "End" || direction) {
        event.preventDefault();
        if (resizeRef.current) return;
        const bounds = panelBounds(side);
        const key: keyof PanelSizes = vertical ? "mobileLeft" : side;
        const size = Math.max(bounds.min, Math.min(bounds.max, panelSizesRef.current[key] ?? bounds.current));
        resizePanel(side, event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max : size + direction * increment);
      }
    };
    return <div className={`sw-resize sw-resize--${side}`} role="separator" tabIndex={0}
      aria-label={`Resize ${side === "left" ? "project" : "agent"} chat`} aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-valuemin={max ? Math.round(min) : undefined} aria-valuemax={max ? Math.round(max) : undefined}
      aria-valuenow={max ? Math.round(Math.max(min, Math.min(max, current))) : undefined}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onKeyDown={keyboard} />;
  }

  const canvasAgents = agents.filter((agent) => agent.role !== "coordinator" && !agent.archivedAt).map((agent) => ({
    ...agent,
    projectLabel: snapshot.projects.length > 1 ? agent.projectId : undefined,
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
    setLifecycleError("");
    setLifecycle({ action, agentId });
  }

  const lifecycleAgent = agents.find((agent) => agent.id === lifecycle?.agentId);
  const affected = lifecycleAgent ? subtree(lifecycleAgent.id) : [];
  const hasRunning = affected.some((agent) => agent.status === "working" || agent.status === "attention" || agent.lifecycleBusy) ||
    (affected.some((agent) => agent.simulation) && agents.some((agent) => agent.simulation && agent.status === "working"));

  async function applyLifecycle() {
    if (!lifecycle || lifecyclePending) return;
    setLifecyclePending(true);
    setLifecycleError("");
    try {
      await send(lifecycle.action === "archive"
        ? { type: "archive", agentId: lifecycle.agentId, stopRunning: hasRunning }
        : { type: lifecycle.action, agentId: lifecycle.agentId });
      setLifecycle(undefined);
      if (lifecycle.action === "delete") requestAnimationFrame(() => archivedToggle.current?.focus());
      if (lifecycle.action === "delete") {
        const ids = new Set(affected.map((agent) => agent.id));
        draftsRef.current = Object.fromEntries(Object.entries(draftsRef.current).filter(([id]) => !ids.has(id)));
        setDrafts(draftsRef.current);
        if (selectedId && ids.has(selectedId)) select(null);
      }
    } catch (error) {
      setLifecycleError(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setLifecyclePending(false);
    }
  }

  function renderChat(agent: Agent, kind: "project" | "agent") {
    const teamIdentity = kind === "agent" && agent.teamId ? snapshot.teams?.find((team) => team.id === agent.teamId) : undefined;
    const team = kind === "agent" && agent.role !== "lead"
      ? agents.find((item) => item.role === "lead" && (item.id === agent.parentId || belongsTo(agent, item.id)))
      : undefined;

    function belongsTo(child: Agent, id: string) {
      const visited = new Set<string>();
      let parent = child.parentId;
      while (parent && !visited.has(parent)) {
        if (parent === id) return true;
        visited.add(parent);
        parent = agents.find((item) => item.id === parent)?.parentId;
      }
      return false;
    }

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
    const effort = settings?.effort ?? settings?.reportedEffort;
    const modelLabel = [model, effort && `${effort} effort${settings?.effort ? " requested" : ""}`].filter(Boolean).join(" · ");

    const scopedUsage = snapshot.usage?.byAgent[agent.id];
    const teamUsage = agent.parentId === projectAgent?.id ? snapshot.usage?.byTeam[agent.teamId ?? agent.id] : undefined;
    const usage = snapshot.usage ? usageLabel(scopedUsage, "Tokens") : undefined;
    const teamTokens = teamUsage ? usageLabel(teamUsage, "Team tokens") : undefined;

    return <WorkspaceChat
      key={agent.id}
      agent={{ ...agent, messages: agent.messages.map((entry) => {
        const source = agents.find((item) => item.id === entry.sourceAgentId);
        return source ? { ...entry, sourceName: `${snapshot.projects.length > 1 && source.projectId ? `${source.projectId} / ` : ""}${agentAppearance(source).displayName}` }
          : entry.sourceAgentId ? { ...entry, sourceName: entry.sourceAgentName ?? "Deleted agent", sourceDeleted: true } : entry;
      }) }}
      kind={kind}
      onOpenAgent={(id) => select(id)}
      onLifecycle={(action) => requestLifecycle(action, agent.id)}
      title={kind === "project" ? projectName : team && snapshot.projects.length === 1
        ? `${agentAppearance(team).displayName} / ${agentAppearance(agent).displayName}`
        : `${agentAppearance(agent).displayName}${team ? ` / ${agentAppearance(team).displayName}`
          : teamIdentity && teamIdentity.name !== agent.name ? ` / ${teamIdentity.name}` : ""}`}
      projectLabel={kind === "agent" && snapshot.projects.length > 1 ? agent.projectId : undefined}
      modelLabel={modelLabel}
      usageLabel={[usage, teamTokens].filter(Boolean).join(" · ")}
      draft={drafts[agent.id] ?? ""}
      composerHeight={composerSizes[kind]}
      onComposerHeightChange={(height) => {
        const next = { ...composerSizesRef.current, [kind]: height };
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
      onApproval={(approvalId, decision) => send({ type: "approval", agentId: agent.id, approvalId, decision })}
      onResumeQueue={() => send({ type: "resumeQueue", agentId: agent.id })}
      onClose={() => kind === "project" ? toggleProjectChat(false) : closeAgent(true)}
      disabled={blocked || Boolean(agent.unavailableReason) || Boolean(agent.archivedAt) || Boolean(agent.lifecycleBusy)}
      disabledReason={agent.unavailableReason ?? (blocked && !(connected && provider.state === "usage-limit") ? blockedReason : undefined)}
      focusMessageId={kind === "agent" ? focus.id : undefined}
      focusRequest={kind === "agent" ? focus.count : undefined}
    />;
  }

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
      <main ref={bodyRef} className={`sw-body ${leftOpen ? "is-project-open" : ""} ${selected ? "is-agent-open" : ""} ${resizing ? "is-resizing" : ""}`}
        style={{ "--left-size": panelSizes.left ? `${panelSizes.left}px` : undefined,
          "--right-size": panelSizes.right ? `${panelSizes.right}px` : undefined,
          "--mobile-left-size": panelSizes.mobileLeft ? `${panelSizes.mobileLeft}px` : undefined } as CSSProperties}>
        <aside className="sw-dock sw-left" aria-label="Project dock">
          <div className="sw-dock-inner" inert={!leftOpen}>{projectAgent && renderChat(projectAgent, "project")}</div>
          {!leftOpen && <button type="button" className="sw-rail-button" aria-label="Expand project chat" title="Expand project chat" onClick={() => toggleProjectChat(true)}>»</button>}
          {leftOpen && resizeHandle("left")}
        </aside>
        <section className="sw-canvas">
          <button ref={archivedToggle} className="sw-archived-toggle" type="button" aria-expanded={archiveOpen} onClick={() => setArchiveOpen(!archiveOpen)}>Archived ({archivedAgents.length})</button>
          {(blocked || storageUnavailable) && <div className="sw-banner" role="status">{blocked ? blockedReason : "Browser storage is unavailable. Drafts and layout changes may not survive reload."}</div>}
          <WorkspaceCanvas agents={canvasAgents} signals={signals} selectedId={selectedId} onSelect={select} onStatus={handleStatus}
            emptyMessage={mode === "claude" ? "Use the project chat to message Claude Code." : undefined}
            initialCamera={savedCamera} onCameraChange={preferences.writeCamera} />
          {archiveOpen && <section className="sw-archive-list" aria-label="Archived agents" onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setArchiveOpen(false); archivedToggle.current?.focus(); }
          }}>
            <header><strong>Archived agents</strong><button type="button" aria-label="Close archived agents" onClick={() => { setArchiveOpen(false); archivedToggle.current?.focus(); }}>×</button></header>
            {!archivedAgents.length && <p>No archived agents.</p>}
            {archivedAgents.map((agent) => {
              const team = snapshot.teams?.find((entry) => entry.id === agent.teamId);
              const parent = agents.find((entry) => entry.id === agent.parentId);
              return <article key={agent.id}>
                <button type="button" onClick={() => { select(agent.id); setArchiveOpen(false); }}>{agentAppearance(agent).displayName}</button>
                <small>Parent: {parent ? agentAppearance(parent).displayName : "Project"}</small>
                {team && <>
                  <small>Team: {team.name}</small>
                  <label className="sw-archived-team-id">Team ID
                    <input value={team.id} readOnly onFocus={(event) => event.currentTarget.select()} />
                  </label>
                </>}
                <small>Archived {new Date(agent.archivedAt!).toLocaleString()}</small>
                <div><button type="button" disabled={!connected || agent.lifecycleBusy} onClick={() => requestLifecycle("restore", agent.id)}>Restore</button>
                  <button type="button" disabled={!connected || agent.lifecycleBusy} onClick={() => requestLifecycle("delete", agent.id)}>Delete permanently…</button></div>
              </article>;
            })}
          </section>}
          {chooser && <div className="sw-activity" role="dialog" aria-label="Events needing attention" onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setChooser(undefined); }
          }}>
            <header><strong>Needs attention</strong><button type="button" aria-label="Close events" onClick={() => setChooser(undefined)}>×</button></header>
            {activityFor(chooser.agentId).map((event, index) => <button key={`${event.agent.id}:${event.messageId}`} type="button" autoFocus={index === 0} onClick={() => select(event.agent.id, event.messageId)}><strong>{snapshot.projects.length > 1 && event.agent.projectId ? `${event.agent.projectId} / ` : ""}{agentAppearance(event.agent).displayName}</strong><span>{event.text}</span></button>)}
          </div>}
        </section>
        <aside className="sw-dock sw-right" aria-label="Agent chat" inert={!selected} onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); closeAgent(true); }
        }}>
          <div className="sw-dock-inner">{dockAgent && renderChat(dockAgent, "agent")}</div>
          {selected && resizeHandle("right")}
        </aside>
      </main>
      <dialog ref={lifecycleDialog} className="sw-lifecycle-dialog" aria-labelledby="lifecycle-heading" onCancel={(event) => {
        if (lifecyclePending) event.preventDefault(); else setLifecycle(undefined);
      }}>
        <h2 id="lifecycle-heading">{lifecycle?.action === "delete" ? "Delete permanently?" : lifecycle?.action === "restore" ? "Restore agents?" : hasRunning ? "Stop and archive?" : "Archive agents?"}</h2>
        <p>{lifecycleAgent && agentAppearance(lifecycleAgent).displayName}</p>
        <p>{affected.length} agent{affected.length === 1 ? "" : "s"} in the selected subtree, including all descendants.</p>
        {lifecycle?.action === "delete" ? <p>Their Orchestra records, conversations, and reports will be permanently removed. Project files, branches, and worktrees stay on disk.</p>
          : lifecycle?.action === "restore" ? <p>Return this subtree to the active map. Any archived ancestors it needs will also be restored. Queued work stays paused.</p>
          : <p>{hasRunning ? "Running work must stop before these agents are hidden. " : ""}Conversations and reports remain available in Archived.</p>}
        {lifecycleError && <p role="alert">{lifecycleError}</p>}
        <footer><button type="button" autoFocus disabled={lifecyclePending} onClick={() => setLifecycle(undefined)}>Cancel</button>
          <button type="button" disabled={!connected || lifecyclePending || !lifecycleAgent} onClick={() => void applyLifecycle()}>
            {lifecyclePending ? "Please wait…" : lifecycle?.action === "delete" ? "Delete permanently" : lifecycle?.action === "restore" ? "Restore" : hasRunning ? "Stop and archive" : "Archive"}
          </button></footer>
      </dialog>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Workspace />);
