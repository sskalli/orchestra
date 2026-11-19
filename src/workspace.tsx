import { agentAppearance, numberAgentRoles } from "./workspace-agent-appearance.ts";
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
type Agent = Snapshot["agents"][number] & { roleNumber: number };
type Command = Parameters<WorkspaceRuntime["command"]>[0];
type Activity = { agent: Agent; messageId?: string; text: string };

const providerLabels = {
  demo: "Demo mode",
  connecting: "Connecting to Codex",
  ready: "Codex connected",
  "signed-out": "Codex sign-in required",
  error: "Codex unavailable",
  "usage-limit": "Codex usage limit",
};

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
  if (pending.length) return pending.map((message) => ({ agent, messageId: message.id, text: message.text }));
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

  const demo = snapshot.provider.state === "demo";
  return <WorkspaceView key={JSON.stringify([snapshot.project.path, demo, snapshot.modelProvider])} snapshot={snapshot} connected={connected} demo={demo} signals={signals} />;
}

function WorkspaceView({ snapshot, connected, demo, signals }: { snapshot: Snapshot; connected: boolean; demo: boolean; signals: AgentSignal[] }) {
  const { project, provider } = snapshot;
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  useEffect(() => {
    const onFailure = () => setStorageUnavailable(true);
    window.addEventListener("orchestra-storage-unavailable", onFailure);
    return () => window.removeEventListener("orchestra-storage-unavailable", onFailure);
  }, []);
  const agents = numberAgentRoles(snapshot.agents);
  const [preferences] = useState(() => workspacePreferences(project.path, demo, snapshot.modelProvider));
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
  const blockedReason = !connected ? "Reconnecting to the local workspace…" : provider.message ?? providerLabels[provider.state];
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
    return agents.filter((agent) => ids.has(agent.id)).flatMap(attention);
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

  const canvasAgents = agents.filter((agent) => agent.role !== "coordinator");

  function renderChat(agent: Agent, kind: "project" | "agent") {
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

    return <WorkspaceChat
      key={agent.id}
      agent={{ ...agent, messages: agent.messages.map((entry) => {
        const source = agents.find((item) => item.id === entry.sourceAgentId);
        return source ? { ...entry, sourceName: agentAppearance(source).displayName } : entry;
      }) }}
      kind={kind}
      onOpenAgent={(id) => select(id)}
      title={kind === "project" ? projectName : team ? `${agentAppearance(team).displayName} / ${agentAppearance(agent).displayName}` : agentAppearance(agent).displayName}
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
      onApproval={(approvalId, decision) => send({ type: "approval", agentId: agent.id, approvalId, decision })}
      onResumeQueue={() => send({ type: "resumeQueue", agentId: agent.id })}
      onClose={() => kind === "project" ? toggleProjectChat(false) : closeAgent(true)}
      disabled={blocked || Boolean(agent.unavailableReason)}
      disabledReason={agent.unavailableReason ?? (blocked && !(connected && provider.state === "usage-limit") ? blockedReason : undefined)}
      focusMessageId={kind === "agent" ? focus.id : undefined}
      focusRequest={kind === "agent" ? focus.count : undefined}
    />;
  }

  return (
    <div className="sw-app">
      <header className="sw-header">
        <div className="sw-brand"><Mark /><span>Orchestra</span></div>
        <div className="sw-project-menu">
          <button className="sw-project-button" type="button" aria-expanded={projectDetails} onClick={() => setProjectDetails(!projectDetails)}><Folder /><span>{projectName}</span><span className="sw-chevron" aria-hidden="true" /></button>
          {projectDetails && <div className="sw-project-details"><strong>{projectName}</strong><span>{project.path}</span></div>}
        </div>
        <div className={`sw-provider sw-provider--${connected ? provider.state : "connecting"}`} role="status"><span aria-hidden="true" />{connected ? providerLabels[provider.state] : "Reconnecting"}</div>
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
          {(blocked || storageUnavailable) && <div className="sw-banner" role="status">{blocked ? blockedReason : "Browser storage is unavailable. Drafts and layout changes may not survive reload."}</div>}
          <WorkspaceCanvas agents={canvasAgents} signals={signals} selectedId={selectedId} onSelect={select} onStatus={handleStatus}
            initialCamera={savedCamera} onCameraChange={preferences.writeCamera} />
          {chooser && <div className="sw-activity" role="dialog" aria-label="Events needing attention" onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setChooser(undefined); }
          }}>
            <header><strong>Needs attention</strong><button type="button" aria-label="Close events" onClick={() => setChooser(undefined)}>×</button></header>
            {activityFor(chooser.agentId).map((event, index) => <button key={`${event.agent.id}:${event.messageId}`} type="button" autoFocus={index === 0} onClick={() => select(event.agent.id, event.messageId)}><strong>{agentAppearance(event.agent).displayName}</strong><span>{event.text}</span></button>)}
          </div>}
        </section>
        <aside className="sw-dock sw-right" aria-label="Agent chat" inert={!selected} onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); closeAgent(true); }
        }}>
          <div className="sw-dock-inner">{dockAgent && renderChat(dockAgent, "agent")}</div>
          {selected && resizeHandle("right")}
        </aside>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Workspace />);
