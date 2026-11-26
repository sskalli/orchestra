import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown } from "react-icons/lu";
import { currentModelChoice } from "./workspace-models.ts";
import type { ModelCatalog, ModelOption, ModelSettings } from "./workspace-models.ts";
import "./workspace-model-picker.css";

export type ModelChange = { model?: string | null; effort?: string | null };

const unavailable: ModelCatalog = { models: [], error: "Orchestra could not list models." };
let catalogRequest: Promise<ModelCatalog> | undefined;

/** Loads the provider's model list once per page; a failed or empty list is fetched again on the next request. */
function loadCatalog(retry = false) {
  if (!catalogRequest || retry) {
    const request: Promise<ModelCatalog> = fetch("/api/models")
      .then((response) => response.ok ? response.json() as Promise<ModelCatalog> : unavailable)
      .catch(() => unavailable)
      .then((catalog) => {
        const models = Array.isArray(catalog?.models) ? catalog.models : [];
        if ((catalog?.error || !models.length) && catalogRequest === request) catalogRequest = undefined;
        return { models, ...(catalog?.error ? { error: catalog.error } : {}) };
      });
    catalogRequest = request;
  }
  return catalogRequest;
}

function useModelCatalog() {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const mounted = useRef(true);
  const reload = useCallback((retry = false) => {
    void loadCatalog(retry).then((next) => { if (mounted.current) setCatalog(next); });
  }, []);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => { mounted.current = false; };
  }, [reload]);
  return { catalog, reload };
}

type ModelPickerProps = {
  /** The task's settings, or the draft choice in the New session dialog. */
  settings?: ModelSettings;
  onChange: (change: ModelChange) => Promise<void> | void;
  disabled?: boolean;
  /** A turn is running, so a change applies from the next turn. */
  busy?: boolean;
  /** Where the menu opens relative to the button. */
  placement?: "above" | "below";
  className?: string;
};

/** A model and reasoning-effort menu. Choices apply to the task's next turn. */
export function ModelPicker({ settings, onChange, disabled, busy, placement = "above", className }: ModelPickerProps) {
  const { catalog, reload } = useModelCatalog();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [appliesNextTurn, setAppliesNextTurn] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const listed = catalog?.models ?? [];
  const { modelId, option, effort } = currentModelChoice(settings, listed);
  // A model the provider did not list (a custom provider or an environment override) stays selectable as it is.
  const models: ModelOption[] = option || !modelId ? listed : [{ id: modelId, label: modelId, efforts: [] }, ...listed];
  const selected = option ?? models.find((entry) => entry.id === modelId);
  const efforts = selected?.efforts ?? [];
  const modelLabel = selected?.label ?? modelId ?? (catalog ? "Default model" : "Model");
  const label = [modelLabel, effort].filter(Boolean).join(" · ");

  useEffect(() => {
    if (!busy) setAppliesNextTurn(false);
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    if (!catalog || catalog.error || !catalog.models.length) reload(Boolean(catalog));
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    // The menu is fixed to the viewport so the scrolling composer cannot clip it; moving the page closes it.
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Node && menu.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  function toggle() {
    if (open) return setOpen(false);
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 288));
      setMenuStyle(placement === "above"
        ? { left, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(120, rect.top - 12) }
        : { left, top: rect.bottom + 4, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 12) });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const items = menuItems();
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus({ preventScroll: true });
  }, [open, catalog]);

  function menuItems() {
    return [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
  }

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  async function apply(change: ModelChange) {
    close();
    setSaving(true);
    setError("");
    try {
      await onChange(change);
      if (busy) setAppliesNextTurn(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The model choice could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function chooseModel(next: ModelOption) {
    if (next === selected) return close();
    const requested = settings?.requestedEffort;
    // Return to the model's default effort when the new model does not offer the chosen one.
    void apply({ model: next.id || null, ...(requested && !next.efforts.includes(requested) ? { effort: null } : {}) });
  }

  function chooseEffort(next: string) {
    if (next === settings?.requestedEffort) return close();
    void apply({ effort: next });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || !open) return;
    if (event.key === "Escape") {
      // The menu closes before anything behind it, such as the chat dock.
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = menuItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  return <div ref={root} className={`chat-model-picker chat-model-picker--${placement}${className ? ` ${className}` : ""}`} onKeyDown={onKeyDown}>
    <button ref={button} type="button" className="chat-model-picker-button" disabled={disabled || saving}
      aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      aria-label={`Model and reasoning effort: ${label}`} title={`Model and reasoning effort: ${label}`}
      onClick={toggle}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          toggle();
        }
      }}>
      <span className="chat-model-picker-label">{label}</span>
      <LuChevronDown aria-hidden="true" strokeWidth={1.5} />
    </button>
    {appliesNextTurn && <span className="chat-model-picker-note" role="status">Applies next turn</span>}
    {error && <span className="chat-model-picker-error" role="alert" title={error}>{error}</span>}
    {open && createPortal(<div ref={menu} id={menuId} className="chat-model-picker-menu" role="menu" aria-label="Model and reasoning effort" style={menuStyle}>
      {!catalog ? <p className="chat-model-picker-status">Loading models…</p> : <>
        {catalog.error && <p className="chat-model-picker-status">
          {catalog.error}{" "}
          <button type="button" className="chat-model-picker-retry" onClick={() => reload(true)}>Retry</button>
        </p>}
        {models.length > 0 && <div role="group" aria-label="Model">
          <p className="chat-model-picker-heading" aria-hidden="true">Model</p>
          {models.map((entry) => <button key={entry.id || "default"} type="button" role="menuitemradio"
            aria-checked={entry === selected} title={entry.description} onClick={() => chooseModel(entry)}>
            <LuCheck aria-hidden="true" strokeWidth={1.5} className="chat-model-picker-check" />
            <span>{entry.label}</span>
          </button>)}
        </div>}
        {efforts.length > 0 && <div role="group" aria-label="Effort">
          <p className="chat-model-picker-heading" aria-hidden="true">Effort</p>
          {efforts.map((entry) => <button key={entry} type="button" role="menuitemradio"
            aria-checked={entry === effort} onClick={() => chooseEffort(entry)}>
            <LuCheck aria-hidden="true" strokeWidth={1.5} className="chat-model-picker-check" />
            <span>{entry}{entry === selected?.defaultEffort ? " (default)" : ""}</span>
          </button>)}
        </div>}
        {busy && <p className="chat-model-picker-status">Changes apply from the next turn.</p>}
      </>}
    </div>, document.body)}
  </div>;
}
