import { agentAppearance } from "./workspace-agent-appearance.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import type { IconType } from "react-icons";
import type { Camera } from "./workspace-preferences.ts";
import type { AgentSignal } from "./workspace-runtime.ts";
import "./workspace-canvas.css";

export type CanvasAgent = {
  id: string;
  parentId?: string | null;
  name: string;
  role: string;
  duty?: string;
  goal?: string;
  projectLabel?: string;
  status: string;
  activity?: string;
};

type Point = { x: number; y: number };
type Node = Point & { agent: CanvasAgent; taskRoot: boolean };
type Team = Point & { depth: number };
type Layout = { nodes: Node[]; teams: Team[] };
type TaskDrag = { id: string; pointerId: number; start: Point; center: Point; scale: number; moved: boolean };
type Gesture = { start: Point; previous: Point; dragged: boolean };
type Pinch = { center: Point; distance: number };

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 5;
const RING_START = 105;
const RING_STEP = 62;
const TAU = Math.PI * 2;
const radiusAt = (depth: number) => RING_START + (depth - 1) * RING_STEP;

function teamCenters(count: number): Point[] {
  const centers = [{ x: 0, y: 0 }];
  const spacing = 560;
  const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let ring = 1; centers.length < count; ring++) {
    let q = -ring;
    let r = ring;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < ring && centers.length < count; step++) {
        centers.push({ x: spacing * (q + r / 2), y: spacing * Math.sqrt(3) / 2 * r });
        q += dq;
        r += dr;
      }
    }
  }
  return centers;
}

export function radialLayout(agents: CanvasAgent[], taskPositions: ReadonlyMap<string, Point> = new Map()): Layout {
  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, CanvasAgent[]>();
  const roots: CanvasAgent[] = [];
  for (const agent of agents) {
    if (!agent.parentId || !ids.has(agent.parentId)) {
      roots.push(agent);
      continue;
    }
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }

  const nodes: Node[] = [];
  const teams: Team[] = [];
  const visited = new Set<string>();
  const centers = teamCenters(roots.length);
  roots.forEach((root, index) => {
    const team = { ...(taskPositions.get(root.id) ?? centers[index]), depth: 0 };
    const walk = (agent: CanvasAgent, depth: number, angle: number, sector: number) => {
      if (visited.has(agent.id)) return;
      visited.add(agent.id);
      const radius = depth ? radiusAt(depth) : 0;
      nodes.push({
        agent,
        taskRoot: depth === 0,
        x: team.x + Math.cos(angle) * radius,
        y: team.y + Math.sin(angle) * radius,
      });
      team.depth = Math.max(team.depth, depth);
      const siblings = children.get(agent.id) ?? [];
      const share = (depth === 0 ? sector : Math.min(sector, Math.PI / 3)) / Math.max(siblings.length, 1);
      siblings.forEach((child, sibling) => {
        walk(child, depth + 1, angle + (sibling - (siblings.length - 1) / 2) * share, share);
      });
    };
    walk(root, 0, index % 2 ? Math.PI / 7 : -Math.PI / 3, TAU);
    teams.push(team);
  });
  return { nodes, teams };
}

function zoom(camera: Camera, anchor: Point, factor: number): Camera {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, camera.scale * factor));
  const ratio = scale / camera.scale;
  return {
    scale,
    x: anchor.x + (camera.x - anchor.x) * ratio,
    y: anchor.y + (camera.y - anchor.y) * ratio,
  };
}

function pair(points: Map<number, Point>): Pinch | null {
  const [a, b] = points.values();
  if (!a || !b) return null;
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

const statuses: Partial<Record<string, { label: string; Icon: IconType }>> = {
  working: { label: "Working", Icon: LuLoaderCircle },
  attention: { label: "Needs attention", Icon: LuTriangleAlert },
  "awaiting-confirmation": { label: "Awaiting confirmation", Icon: LuInfo },
  done: { label: "Complete", Icon: LuCircleCheck },
  error: { label: "Failed", Icon: LuCircleAlert },
  notice: { label: "Update available", Icon: LuInfo },
};

const statusPriority = ["error", "attention", "awaiting-confirmation", "working", "done", "notice"];

function MessageDot({ from, to }: { from: Point; to: Point }) {
  const dot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const animation = dot.current?.animate([
      { transform: `translate(${from.x}px, ${from.y}px)` },
      { transform: `translate(${to.x}px, ${to.y}px)` },
    ], { duration: 250, easing: "linear", fill: "forwards" });
    return () => animation?.cancel();
  }, [from.x, from.y, to.x, to.y]);
  return <span ref={dot} className="swarm-message-dot" aria-hidden="true"
    style={{ left: 0, top: 0 }} />;
}

function Starfield() {
  const layer = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = layer.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const density = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      context.setTransform(density, 0, 0, density, 0, 0);
      context.fillStyle = "#e8e4d8";
      const spacing = 76;
      for (let y = 0; y < height; y += spacing) {
        for (let x = 0; x < width; x += spacing) {
          let seed = Math.imul(x + 31, 73856093) ^ Math.imul(y + 41, 19349663);
          const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
          };
          for (let i = 0; i < 4; i++) {
            const cx = x + random() * spacing;
            const cy = y + random() * spacing;
            const size = random();
            context.globalAlpha = 0.13 + size * size * 0.57;
            context.beginPath();
            context.arc(cx, cy, 0.35 + size * 0.82, 0, Math.PI * 2);
            context.fill();
          }
        }
      }
      context.globalAlpha = 1;
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, []);

  return <canvas className="swarm-starfield" ref={layer} aria-hidden="true" />;
}

export function WorkspaceCanvas({
  agents,
  signals,
  selectedId,
  onSelect,
  onStatus,
  onCreateTask,
  emptyMessage = "Select + to start a session.",
  initialCamera,
  onCameraChange,
}: {
  agents: CanvasAgent[];
  signals: AgentSignal[];
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  onStatus: (id: string) => void;
  onCreateTask?: () => void;
  emptyMessage?: string;
  initialCamera?: Camera;
  onCameraChange?: (camera: Camera) => void;
}) {
  const [taskPositions, setTaskPositions] = useState(() => new Map<string, Point>());
  const layout = useMemo(() => radialLayout(agents, taskPositions), [agents, taskPositions]);
  const taskDrag = useRef<TaskDrag | null>(null);
  const suppressTaskClick = useRef<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const [camera, setCamera] = useState<Camera>(initialCamera ?? { x: 0, y: 0, scale: 1 });
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [statusHovered, setStatusHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const firstFit = useRef(Boolean(initialCamera));

  useEffect(() => {
    if (firstFit.current) onCameraChange?.(camera);
  }, [camera, onCameraChange]);

  const fit = useCallback(() => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height || layout.teams.length === 0) return false;
    const bounds = layout.teams.map((team) => {
      const radius = team.depth > 1 ? radiusAt(team.depth) : radiusAt(2);
      return { left: team.x - radius, right: team.x + Math.max(radius, 240), top: team.y - radius, bottom: team.y + radius };
    });
    const left = Math.min(...bounds.map((bound) => bound.left));
    const right = Math.max(...bounds.map((bound) => bound.right));
    const top = Math.min(...bounds.map((bound) => bound.top));
    const bottom = Math.max(...bounds.map((bound) => bound.bottom));
    const scale = Math.max(MIN_SCALE, Math.min(1.05, (rect.width - 60) / (right - left), (rect.height - 92) / (bottom - top)));
    setCamera({
      x: rect.left + rect.width / 2 - (left + right) * scale / 2,
      y: rect.top + (rect.height - 38) / 2 - (top + bottom) * scale / 2,
      scale,
    });
    return true;
  }, [layout]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setOrigin((previous) => previous.x === rect.left && previous.y === rect.top ? previous : { x: rect.left, y: rect.top });
      if (!firstFit.current) firstFit.current = fit();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const container = element.parentElement;
    container?.addEventListener("transitionend", measure);
    container?.addEventListener("transitioncancel", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      container?.removeEventListener("transitionend", measure);
      container?.removeEventListener("transitioncancel", measure);
      window.removeEventListener("resize", measure);
    };
  }, [fit]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (taskDrag.current) return;
      const units = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight : 1;
      const factor = Math.exp(-Math.max(-110, Math.min(110, event.deltaY * units)) * 0.0035);
      setCamera((value) => zoom(value, { x: event.clientX, y: event.clientY }, factor));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.agent.id, node])), [layout]);
  const highlighted = new Set([selectedId, hovered, focused]);
  const children = new Map<string, CanvasAgent[]>();
  for (const { agent } of layout.nodes) {
    if (!agent.parentId) continue;
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }

  function subtree(root: CanvasAgent) {
    const members = new Map([[root.id, root]]);
    for (const agent of members.values()) {
      for (const child of children.get(agent.id) ?? []) members.set(child.id, child);
    }
    return [...members.values()];
  }

  function subtreeIds(rootId: string) {
    const ids = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      if (!id || ids.has(id)) continue;
      ids.add(id);
      for (const child of children.get(id) ?? []) queue.push(child.id);
    }
    return ids;
  }

  const selectedRevealed = new Set<string>();
  if (selectedId) {
    for (const id of subtreeIds(selectedId)) selectedRevealed.add(id);
  }

  const interactionRevealed = new Set<string>();
  for (const id of [hovered, focused]) {
    if (!id) continue;
    for (const childId of subtreeIds(id)) interactionRevealed.add(childId);
  }

  const revealed = new Set<string>([...selectedRevealed, ...interactionRevealed]);

  const links = new Map<string, [Node, Node]>();
  for (const node of layout.nodes) {
    const parent = positions.get(node.agent.parentId ?? "");
    if (parent && revealed.has(parent.agent.id)) links.set(node.agent.id, [node, parent]);
    if (!highlighted.has(node.agent.id)) continue;
    const visited = new Set<string>();
    let child = node;
    while (child.agent.parentId && !visited.has(child.agent.id)) {
      const ancestor = positions.get(child.agent.parentId);
      if (!ancestor) break;
      links.set(child.agent.id, [child, ancestor]);
      visited.add(child.agent.id);
      child = ancestor;
    }
  }

  function taskPointerDown(event: PointerEvent<HTMLButtonElement>, id: string, center: Point) {
    if (event.button !== 0 || taskDrag.current || pointers.current.size) return;
    suppressTaskClick.current = null;
    taskDrag.current = {
      id, pointerId: event.pointerId, center, scale: camera.scale,
      start: { x: event.clientX, y: event.clientY }, moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function taskPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = taskDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    suppressTaskClick.current = drag.id;
    setTaskPositions((previous) => new Map(previous).set(drag.id, {
      x: drag.center.x + dx / drag.scale,
      y: drag.center.y + dy / drag.scale,
    }));
  }

  function taskPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (taskDrag.current?.pointerId === event.pointerId) taskDrag.current = null;
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || taskDrag.current || (event.target as Element).closest("button, .swarm-canvas-controls")) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 1) gesture.current = { start: point, previous: point, dragged: false };
    else if (gesture.current) {
      gesture.current.dragged = true;
      setDragging(true);
    }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const tracking = gesture.current;
    if (!tracking || !pointers.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    const prior = pair(pointers.current);
    pointers.current.set(event.pointerId, point);
    const next = pair(pointers.current);
    if (prior && next && prior.distance > 0 && next.distance > 0) {
      setCamera((value) => {
        const scaled = zoom(value, prior.center, next.distance / prior.distance);
        return { ...scaled, x: scaled.x + next.center.x - prior.center.x, y: scaled.y + next.center.y - prior.center.y };
      });
      return;
    }
    if (!tracking.dragged && Math.hypot(point.x - tracking.start.x, point.y - tracking.start.y) < DRAG_THRESHOLD) return;
    tracking.dragged = true;
    setDragging(true);
    const offset = { x: point.x - tracking.previous.x, y: point.y - tracking.previous.y };
    tracking.previous = point;
    setCamera((value) => ({ ...value, x: value.x + offset.x, y: value.y + offset.y }));
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    if (!pointers.current.delete(event.pointerId)) return;
    const remaining = pointers.current.values().next().value;
    if (remaining && gesture.current) {
      gesture.current.previous = remaining;
      return;
    }
    if (!cancelled && gesture.current && !gesture.current.dragged &&
        Math.hypot(event.clientX - gesture.current.start.x, event.clientY - gesture.current.start.y) < DRAG_THRESHOLD) {
      onSelect(null);
    }
    gesture.current = null;
    setDragging(false);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && selectedId) {
      event.stopPropagation();
      onSelect(null);
      nodes.current.get(selectedId)?.focus();
      return;
    }
    const directions: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
    };
    const direction = directions[event.key];
    const from = positions.get((event.target as HTMLElement).dataset.agentId ?? "");
    if (!direction || !from) return;
    let next: Node | undefined;
    let score = Infinity;
    for (const node of layout.nodes) {
      const dx = node.x - from.x;
      const dy = node.y - from.y;
      const forward = dx * direction.x + dy * direction.y;
      if (forward <= 0) continue;
      const lateral = Math.abs(dx * direction.y - dy * direction.x);
      const candidate = forward + lateral * 2;
      if (candidate < score) {
        next = node;
        score = candidate;
      }
    }
    if (next) {
      event.preventDefault();
      nodes.current.get(next.agent.id)?.focus();
    }
  }

  function zoomCenter(factor: number) {
    const rect = viewport.current?.getBoundingClientRect();
    if (rect) setCamera((value) => zoom(value, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, factor));
  }

  return (
    <div
      ref={viewport}
      className={`swarm-canvas${dragging ? " is-panning" : ""}`}
      role="region"
      aria-label="Task map"
      data-camera-x={camera.x}
      data-camera-y={camera.y}
      data-camera-scale={camera.scale}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={(event) => pointerEnd(event, true)}
      onLostPointerCapture={(event) => pointerEnd(event, true)}
      onKeyDown={keyboard}
    >
      <Starfield />
      {layout.nodes.length === 0 && <div className="swarm-canvas-empty">{emptyMessage}</div>}
      <div
        className="swarm-canvas-world"
        style={{
          transform: `translate(${camera.x - origin.x}px, ${camera.y - origin.y}px) scale(${camera.scale})`,
          "--swarm-overlay-scale": String(1 / camera.scale),
        } as CSSProperties}
      >
        <svg className="swarm-canvas-guides" aria-hidden="true" width="1" height="1">
          {layout.teams.flatMap((team, index) => Array.from({ length: team.depth }, (_, ring) => (
            <circle key={`${index}-${ring}`} cx={team.x} cy={team.y} r={radiusAt(ring + 1)} />
          )))}
          {[...links].map(([id, [child, parent]]) => <line key={id} x1={child.x} y1={child.y} x2={parent.x} y2={parent.y} />)}
          {signals.map((signal) => {
            const sender = positions.get(signal.senderId);
            const recipient = positions.get(signal.recipientId);
            if (!sender || !recipient || (sender.agent.parentId !== recipient.agent.id && recipient.agent.parentId !== sender.agent.id)) return null;
            return <g key={signal.id} className="swarm-signal">
              <line className="swarm-signal-link" x1={sender.x} y1={sender.y} x2={recipient.x} y2={recipient.y} />
            </g>;
          })}
        </svg>
        {signals.map((signal) => {
          const sender = positions.get(signal.senderId);
          const recipient = positions.get(signal.recipientId);
          if (!sender || !recipient || (sender.agent.parentId !== recipient.agent.id && recipient.agent.parentId !== sender.agent.id)) return null;
          return <MessageDot key={signal.id} from={sender} to={recipient} />;
        })}
        {layout.nodes.map(({ agent, x, y, taskRoot }) => {
          const members = taskRoot ? subtree(agent) : [agent];
          const statusAgent = statusPriority.map((level) => members.find((member) => member.status === level))
            .find((member) => member !== undefined) ?? agent;
          const status = taskRoot || revealed.has(agent.id) ? statuses[statusAgent.status] : undefined;
          const statusLabel = status?.label ?? statuses[statusAgent.status]?.label ?? "Idle";
          const { color, displayName, roleLabel } = agentAppearance(agent, taskRoot);
          const selected = agent.id === selectedId;
          const showChildStatusIcon = Boolean(status) && selectedRevealed.has(agent.id) && !highlighted.has(agent.id);
          const describedRole = agent.goal ?? agent.duty ?? agent.activity ?? statuses[statusAgent.status]?.label ?? "Idle";
          const tooltipId = `swarm-node-tooltip-${agent.id}`;
          const accessibleName = `${displayName}${agent.projectLabel ? `, project ${agent.projectLabel}` : ""}`;
          const label = `${accessibleName}, ${agent.activity ?? statuses[statusAgent.status]?.label ?? "Idle"}`;
          return (
            <div
              key={agent.id}
              data-agent-color={color}
              className={`swarm-node ${taskRoot ? "is-task-root" : "is-child"}${selected ? " is-selected" : ""}${statusHovered === agent.id ? " is-status-hovered" : ""}${showChildStatusIcon ? " is-subtree-only" : ""}`}
              style={{ left: x, top: y }}
              onPointerEnter={() => setHovered(agent.id)}
              onPointerLeave={() => {
                setHovered((id) => id === agent.id ? null : id);
                setStatusHovered((id) => id === agent.id ? null : id);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setFocused((id) => id === agent.id ? null : id);
                  setStatusHovered((id) => id === agent.id ? null : id);
                }
              }}
            >
              <button
                ref={(element) => { if (element) nodes.current.set(agent.id, element); else nodes.current.delete(agent.id); }}
                type="button"
                className="swarm-node-target"
                aria-label={label}
                aria-pressed={selected}
                data-agent-id={agent.id}
                data-world-x={x}
                data-world-y={y}
                onPointerDown={taskRoot ? (event) => taskPointerDown(event, agent.id, { x, y }) : undefined}
                onPointerMove={taskRoot ? taskPointerMove : undefined}
                onPointerUp={taskRoot ? taskPointerEnd : undefined}
                onPointerCancel={taskRoot ? taskPointerEnd : undefined}
                onLostPointerCapture={taskRoot ? taskPointerEnd : undefined}
                onClick={(event) => {
                  if (event.detail > 0 && suppressTaskClick.current === agent.id) {
                    suppressTaskClick.current = null;
                    return;
                  }
                  onSelect(agent.id);
                }}
                onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setFocused(agent.id); }}
              ><span className="swarm-node-disc" /></button>
              <div className="swarm-team-label">
                <div className="swarm-team-label-content">
                  <strong>
                    {status && <button
                      type="button"
                      className={`swarm-team-status-icon status-${statusAgent.status}`}
                      aria-label={`${accessibleName}: ${statusLabel}`}
                      aria-describedby={tooltipId}
                      onClick={() => onStatus(taskRoot &&
                        (statusAgent.status === "error" || statusAgent.status === "attention") ? agent.id : statusAgent.id)}
                      onPointerEnter={() => setStatusHovered(agent.id)}
                      onPointerLeave={() => setStatusHovered((id) => id === agent.id ? null : id)}
                      onFocus={(event) => {
                        if (event.currentTarget.matches(":focus-visible")) {
                          setFocused(agent.id);
                          setStatusHovered(agent.id);
                        }
                      }}
                      onBlur={() => {
                        setStatusHovered((id) => id === agent.id ? null : id);
                      }}
                    ><status.Icon aria-hidden="true" focusable="false" /></button>}
                    <span>{displayName}{roleLabel && <> | <span className="swarm-label-topic">{roleLabel}</span></>}</span>
                  </strong>
                  <div className="swarm-label-subtitle">
                    <span title={describedRole}>{describedRole}</span>
                    {agent.projectLabel && <span>Project: {agent.projectLabel}</span>}
                  </div>
                </div>
              </div>
              {status && <div className="swarm-node-tooltip" id={tooltipId}>
                <div className="swarm-node-tooltip-content">
                  <strong>{displayName}</strong>
                  <span>{agent.activity ?? statuses[statusAgent.status]?.label ?? "Idle"}</span>
                </div>
              </div>}
            </div>
          );
        })}
      </div>
      {(onCreateTask || layout.nodes.length > 0) && <div className="swarm-canvas-controls" aria-label="Canvas controls">
        {onCreateTask && <button type="button" aria-label="New session" title="New session" onClick={onCreateTask}>+</button>}
        {layout.nodes.length > 0 && <>
          <button type="button" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.2)}>−</button>
          <output aria-label="Zoom level">{Math.round(camera.scale * 100)}%</output>
          <button type="button" aria-label="Zoom in" onClick={() => zoomCenter(1.2)}>+</button>
          <button type="button" className="swarm-fit" onClick={fit}>Fit all tasks</button>
        </>}
      </div>}
    </div>
  );
}
