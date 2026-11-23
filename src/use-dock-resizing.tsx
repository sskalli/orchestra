import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { PanelSizes, workspacePreferences } from "./workspace-preferences.ts";

type Handle = "left" | "right" | "bottom" | "corner";
type SizeKey = keyof PanelSizes;
type DockStyle = CSSProperties & Partial<Record<`--${string}`, string>>;
type DockPreferences = Pick<ReturnType<typeof workspacePreferences>, "readPanels" | "writePanels">;

const sizeProperties: Record<SizeKey, `--${string}`> = {
  left: "--left-size", right: "--right-size", leftHeight: "--left-height-size",
  mobileLeft: "--mobile-left-size", mobileLeftWidth: "--mobile-left-width",
};
const emptyMetrics = { width: 0, height: 0, left: 0, right: 0, leftHeight: 0, chatTop: 0, inset: 0, gap: 0 };
type Metrics = typeof emptyMetrics;
type Axis = { key: SizeKey; vertical: boolean; sign: number };
type DragAxis = Axis & { start: number; size: number };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function useDockResizing(preferences: DockPreferences, inboxOpen: boolean, chatOpen: boolean) {
  const [panelSizes, setPanelSizes] = useState(preferences.readPanels);
  const panelSizesRef = useRef(panelSizes);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 650px)").matches);
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ pointerId: number; axes: DragAxis[] } | null>(null);
  const [panelMetrics, setPanelMetrics] = useState(emptyMetrics);
  const panelMetricsRef = useRef(panelMetrics);
  const resizeFrame = useRef<number | null>(null);
  const pendingResize = useRef<{ entries: [SizeKey, number][]; handle: HTMLDivElement } | null>(null);

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
      const style = getComputedStyle(body);
      const next = {
        width: bounds.width, height: bounds.height, left: leftBounds.width, right: rightBounds.width,
        leftHeight: leftBounds.height, chatTop: rightBounds.top - bounds.top,
        inset: parseFloat(style.getPropertyValue("--window-inset")),
        gap: parseFloat(style.getPropertyValue("--panel-gap")),
      };
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

  function panelBounds({ key, vertical }: Axis, metrics: Metrics) {
    const { width, height, left, right, leftHeight, chatTop, inset, gap } = metrics;
    const sharedWidth = width - 2 * inset - gap;
    let current = left;
    let min = 200;
    let max = Math.min(width * .5, chatOpen ? sharedWidth - right : width);
    if (vertical) {
      current = leftHeight;
      min = 160;
      max = mobile && chatOpen ? chatTop - inset - gap : height - 2 * inset;
    } else if (key === "right") {
      current = right;
      min = Math.min(230, width * .25);
      max = Math.min(width * .75, inboxOpen ? sharedWidth - left : width);
    } else if (mobile) {
      max = width - 2 * inset;
    }
    max = Math.max(0, max);
    return { current, min: Math.min(min, max), max };
  }

  function flushResize() {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    const pending = pendingResize.current;
    if (!pending) return;
    // Preview the drag without rendering the whole workspace on every pointer move.
    for (const [key, value] of pending.entries) {
      bodyRef.current?.style.setProperty(sizeProperties[key], `${value}px`);
    }
    pending.handle.setAttribute("aria-valuenow", String(Math.round(pending.entries[0][1])));
    pendingResize.current = null;
  }

  function resizeHandle(handle: Handle) {
    const horizontalAxis: Axis = handle === "right"
      ? { key: "right", vertical: false, sign: -1 }
      : { key: mobile ? "mobileLeftWidth" : "left", vertical: false, sign: 1 };
    const verticalAxis: Axis = { key: mobile ? "mobileLeft" : "leftHeight", vertical: true, sign: 1 };
    const axes = handle === "corner" ? [horizontalAxis, verticalAxis]
      : [handle === "bottom" ? verticalAxis : horizontalAxis];
    const { min, max, current } = panelBounds(axes[0], panelMetrics);
    const label = {
      left: "Resize Inbox width", right: "Resize agent chat",
      bottom: "Resize Inbox height", corner: "Resize Inbox width and height",
    }[handle];

    const start = (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || resizeRef.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = { pointerId: event.pointerId, axes: axes.map((axis) => ({
        ...axis, start: axis.vertical ? event.clientY : event.clientX,
        size: panelBounds(axis, panelMetricsRef.current).current,
      })) };
      setResizing(true);
    };
    const move = (event: PointerEvent<HTMLDivElement>) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const entries = drag.axes.map((axis): [SizeKey, number] => {
        const distance = (axis.vertical ? event.clientY : event.clientX) - axis.start;
        const { min, max } = panelBounds(axis, panelMetricsRef.current);
        return [axis.key, clamp(axis.size + axis.sign * distance, min, max)];
      });
      if (chatOpen && drag.axes.some(({ key }) => key === "left")) {
        entries.push(["right", panelMetricsRef.current.right]);
      }
      panelSizesRef.current = { ...panelSizesRef.current, ...Object.fromEntries(entries) };
      pendingResize.current = { entries, handle: event.currentTarget };
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
      const isLimit = event.key === "Home" || event.key === "End";
      const direction = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key];
      const keyIsVertical = event.key === "ArrowUp" || event.key === "ArrowDown";
      const applicable = axes.filter((axis) => isLimit || (direction && axis.vertical === keyIsVertical));
      if (!applicable.length) return;
      event.preventDefault();
      if (resizeRef.current) return;
      const increment = event.shiftKey ? 50 : 10;
      const next = { ...panelSizesRef.current };
      if (chatOpen && applicable.some(({ key }) => key === "left")) {
        next.right = panelMetricsRef.current.right;
      }
      for (const axis of applicable) {
        const { current, min, max } = panelBounds(axis, panelMetricsRef.current);
        next[axis.key] = event.key === "Home" ? min : event.key === "End" ? max
          : clamp(clamp(next[axis.key] ?? current, min, max) + (direction ?? 0) * axis.sign * increment, min, max);
      }
      panelSizesRef.current = next;
      setPanelSizes(next);
    };
    return <div className={`sw-resize sw-resize--${handle}`} role="separator" tabIndex={0}
      aria-label={label} aria-orientation={handle === "bottom" ? "horizontal" : "vertical"}
      aria-valuemin={max ? Math.round(min) : undefined} aria-valuemax={max ? Math.round(max) : undefined}
      aria-valuenow={max ? Math.round(clamp(current, min, max)) : undefined}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onKeyDown={keyboard} />;
  }

  const style: DockStyle = {};
  for (const key of Object.keys(sizeProperties) as SizeKey[]) {
    const size = panelSizes[key];
    if (size !== undefined) style[sizeProperties[key]] = `${size}px`;
  }
  return { bodyRef, resizing, style, resizeHandle };
}
