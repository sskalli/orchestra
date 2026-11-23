import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { PanelSizes, workspacePreferences } from "./workspace-preferences.ts";

type DockSide = "left" | "right";
type DockStyle = CSSProperties & {
  "--left-size"?: string;
  "--right-size"?: string;
  "--mobile-left-size"?: string;
};

type DockPreferences = Pick<ReturnType<typeof workspacePreferences>, "readPanels" | "writePanels">;

export function useDockResizing(preferences: DockPreferences) {
  const [panelSizes, setPanelSizes] = useState(preferences.readPanels);
  const panelSizesRef = useRef(panelSizes);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 650px)").matches);
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ pointerId: number; start: number; size: number; side: DockSide; vertical: boolean } | null>(null);
  const [panelMetrics, setPanelMetrics] = useState({ width: 0, height: 0, left: 0, right: 0, leftHeight: 0 });
  const panelMetricsRef = useRef(panelMetrics);
  const resizeFrame = useRef<number | null>(null);
  const pendingResize = useRef<{ key: keyof PanelSizes; value: number; handle: HTMLDivElement } | null>(null);

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

  function panelBounds(side: DockSide) {
    const metrics = panelMetricsRef.current;
    if (side === "right") {
      const width = metrics.width;
      const min = mobile ? Math.min(230, width * 0.60) : Math.min(230, width * 0.25);
      return { min, max: width * 0.75, current: metrics.right };
    }

    const maximum = mobile ? metrics.height - 130 : metrics.width * 0.44;
    const max = Math.max(0, maximum);
    return {
      min: Math.min(mobile ? 160 : 200, max),
      max,
      current: mobile ? metrics.leftHeight : metrics.left,
    };
  }

  function resizePanel(side: DockSide, value: number) {
    const { min, max } = panelBounds(side);
    const key: keyof PanelSizes = mobile && side === "left" ? "mobileLeft" : side;
    const next = { ...panelSizesRef.current, [key]: Math.max(min, Math.min(max, value)) };
    panelSizesRef.current = next;
    setPanelSizes(next);
  }

  const rightBounds = panelBounds("right");
  const compactWidth = Math.max(rightBounds.min, panelMetricsRef.current.width * 0.25);
  const chatExpanded = (panelSizes.right ?? rightBounds.current) > (compactWidth + rightBounds.max) / 2;

  function toggleChatWidth() {
    if (!panelMetricsRef.current.width) return;
    resizePanel("right", chatExpanded ? compactWidth : rightBounds.max);
  }

  function flushResize() {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    const pending = pendingResize.current;
    if (!pending) return;
    const property = pending.key === "mobileLeft" ? "--mobile-left-size" : `--${pending.key}-size`;
    // Update the drag preview without re-rendering the workspace on every pointer move.
    bodyRef.current?.style.setProperty(property, `${pending.value}px`);
    pending.handle.setAttribute("aria-valuenow", String(Math.round(pending.value)));
    pendingResize.current = null;
  }

  function resizeHandle(side: DockSide) {
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
      const value = Math.max(min, Math.min(max,
        drag.size + (drag.side === "right" || drag.vertical ? -distance : distance)));
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

  const style: DockStyle = {
    "--left-size": panelSizes.left ? `${panelSizes.left}px` : undefined,
    "--right-size": panelSizes.right ? `${panelSizes.right}px` : undefined,
    "--mobile-left-size": panelSizes.mobileLeft ? `${panelSizes.mobileLeft}px` : undefined,
  };

  function openChatWidth() {
    if (panelMetricsRef.current.width) resizePanel("right", panelMetricsRef.current.width * 0.65);
  }

  return { bodyRef, resizing, style, resizeHandle, chatExpanded, toggleChatWidth, openChatWidth };
}
