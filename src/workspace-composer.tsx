// Shared prompt-composer behaviour: list continuation and indentation, plus "/" skill autocomplete.
import { useEffect, useId, useLayoutEffect, useState } from "react";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { completeSkill, continueList, indentList, rankSkills, slashKeyAction, slashToken } from "./workspace-composer-text.ts";
import type { TextEdit } from "./workspace-composer-text.ts";
import "./workspace-composer.css";

type Skill = { name: string; description: string; argumentHint?: string };
type SkillState = { status: "loading" | "ready" | "error"; skills: Skill[]; engine?: string; error?: string; scope?: string };

// The server caches lists and drops them when skill files change, so the browser only shares a request in flight.
const skillRequests = new Map<string, Promise<SkillState>>();

/** Project skills apply only to tasks with that repository, so lists are loaded per repository scope. */
function loadSkills(scope: string): Promise<SkillState> {
  const pending = skillRequests.get(scope);
  if (pending) return pending;
  const promise = fetch(`/api/skills${scope ? `?projects=${encodeURIComponent(scope)}` : ""}`).then(async (response) => {
    const body = await response.json().catch(() => ({})) as { engine?: string; skills?: Skill[]; error?: string };
    if (!response.ok || !Array.isArray(body.skills)) {
      return { status: "error" as const, skills: [], engine: body.engine, error: body.error ?? "Skills could not be loaded." };
    }
    return { status: "ready" as const, skills: body.skills, engine: body.engine };
  }, () => ({ status: "error" as const, skills: [], error: "Skills could not be loaded." }));
  skillRequests.set(scope, promise);
  void promise.then(() => { if (skillRequests.get(scope) === promise) skillRequests.delete(scope); });
  return promise;
}

/** Applies an edit through the browser's editing commands so native undo and redo keep working. */
export function applyTextEdit(textarea: HTMLTextAreaElement, edit: TextEdit) {
  textarea.focus();
  textarea.setSelectionRange(edit.start, edit.end);
  let applied = false;
  try {
    applied = edit.text ? document.execCommand("insertText", false, edit.text)
      : edit.start === edit.end || document.execCommand("delete", false);
  } catch {
    applied = false;
  }
  if (!applied) {
    textarea.setRangeText(edit.text, edit.start, edit.end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

const menuGap = 6;
const preferredMenuHeight = 260;

/**
 * Adds list editing and "/" skill autocomplete to a textarea. Call `handleKey` first in the textarea's
 * key handler: when it returns true the key was consumed (or belongs to an IME) and must not send.
 */
export function useComposerAssist({ textarea, anchor, value, projectIds, disabled }: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** The element the menu aligns with; it opens above it when there is room. */
  anchor: RefObject<HTMLElement | null>;
  value: string;
  /** The task's repositories; project skills depend on them. */
  projectIds: readonly string[];
  disabled?: boolean;
}) {
  const scope = projectIds.join(",");
  const listId = useId();
  const [caret, setCaret] = useState<number>();
  const [dismissedAt, setDismissedAt] = useState<number>();
  const [active, setActive] = useState(0);
  /** Whether the user picked the active row with the arrow keys or the pointer, rather than it being the first match. */
  const [navigated, setNavigated] = useState(false);
  const [skills, setSkills] = useState<SkillState>();
  const [position, setPosition] = useState<CSSProperties>();

  const token = caret === undefined || disabled ? undefined : slashToken(value, caret);
  const open = Boolean(token) && dismissedAt !== token!.start;
  const ranked = open && skills ? rankSkills(skills.skills, token!.query) : [];
  const matches = ranked.map(({ skill }) => skill);
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  // Highlight a row only when Enter or Tab would complete it; a substring match needs an explicit choice.
  const actionable = navigated || (ranked[activeIndex]?.kind ?? "substring") !== "substring";
  const activeId = open && matches.length && actionable ? `${listId}-${activeIndex}` : undefined;

  useEffect(() => {
    if (!token) setDismissedAt(undefined);
  }, [token?.start]);

  useEffect(() => {
    setActive(0);
    setNavigated(false);
  }, [token?.query, open]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    // Keep showing the previous list for this scope while it refreshes.
    if (!skills || skills.status === "error" || skills.scope !== scope) setSkills({ status: "loading", skills: [], scope });
    void loadSkills(scope).then((state) => { if (current) setSkills({ ...state, scope }); });
    return () => { current = false; };
  }, [open, scope]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top >= preferredMenuHeight + menuGap || rect.top > window.innerHeight - rect.bottom;
      const room = (above ? rect.top : window.innerHeight - rect.bottom) - menuGap * 2;
      setPosition({
        left: rect.left, width: rect.width, maxHeight: Math.max(80, Math.min(preferredMenuHeight, room)),
        ...(above ? { bottom: window.innerHeight - rect.top + menuGap } : { top: rect.bottom + menuGap }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, value, anchor]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function syncCaret() {
    const element = textarea.current;
    setCaret(element && document.activeElement === element && element.selectionStart === element.selectionEnd
      ? element.selectionEnd : undefined);
  }

  function choose(skill: Skill) {
    const element = textarea.current;
    if (!element || !token) return;
    applyTextEdit(element, completeSkill(element.value, token, skill.name));
    syncCaret();
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Keys that finish an IME composition belong to the IME.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return true;
    const element = textarea.current;
    if (!element) return false;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    if (open && !modified) {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        // The first arrow press from an unhighlighted list selects its first or last row.
        setActive(actionable ? (activeIndex + step + matches.length) % matches.length : step > 0 ? 0 : matches.length - 1);
        setNavigated(true);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey &&
          slashKeyAction(ranked[activeIndex], token!.query, event.key, navigated) === "complete") {
        event.preventDefault();
        choose(matches[activeIndex]);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(token!.start);
        return true;
      }
    }
    if (event.key === "Enter" && event.shiftKey && !modified) {
      const edit = continueList(element.value, element.selectionStart, element.selectionEnd);
      if (!edit) return false;
      event.preventDefault();
      applyTextEdit(element, edit);
      return true;
    }
    if (event.key === "Tab" && !modified) {
      const edit = indentList(element.value, element.selectionStart, element.selectionEnd, event.shiftKey);
      if (!edit) return false;
      event.preventDefault();
      applyTextEdit(element, edit);
      return true;
    }
    return false;
  }

  const status = !skills || skills.status === "loading" ? "Loading skills…"
    : skills.status === "error" ? skills.error
    : !skills.skills.length ? `${skills.engine ?? "This engine"} offers no skills here.`
    : !matches.length ? "No matching skills" : undefined;

  const menu = open && position ? <div className="chat-slash-menu" style={position}
    onMouseDown={(event) => event.preventDefault()}>
    <ul id={listId} role="listbox" aria-label="Skills">
      {matches.map((skill, index) => <li key={skill.name} id={`${listId}-${index}`} role="option"
        aria-selected={index === activeIndex && actionable} title={skill.description || undefined}
        onMouseEnter={() => { setActive(index); setNavigated(true); }} onClick={() => choose(skill)}>
        <span className="chat-slash-name">/{skill.name}{skill.argumentHint ? <span> {skill.argumentHint}</span> : null}</span>
        {skill.description ? <span className="chat-slash-description">{skill.description}</span> : null}
      </li>)}
    </ul>
    {status ? <p className="chat-slash-status" role="status">{status}</p> : null}
  </div> : null;

  return {
    handleKey,
    menu,
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list" as const,
      "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": activeId,
      onSelect: syncCaret,
      onInput: syncCaret,
      onFocus: syncCaret,
    },
    onBlur: () => setCaret(undefined),
  };
}
