import { LuChevronDown, LuChevronRight, LuFileDiff, LuX } from "react-icons/lu";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import type { DiffFile, DiffGroup, TaskDiff } from "./workspace-diff.ts";
import { buildFileTree, treeFiles, type FileTreeNode } from "./workspace-diff-tree.ts";
import type { WorkspaceAgent } from "./workspace-runtime.ts";
import "./workspace-diff-panel.css";

export type DiffLayout = "floating" | "tabs" | "overlay";
type DiffPreferences = { readDiffWidth(): number | undefined; writeDiffWidth(width: number): void };

const panelId = "workspace-diff-panel";
const minWidth = 280;
const defaultWidth = 380;
/** Narrowest the chat is squeezed to so the panel fits beside it. */
const minChatWidth = 340;
const minMap = 120;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** The header button that opens the changes panel beside the chat. */
export function DiffToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button className="interface-icon-button sw-diff-toggle" type="button" aria-label="Show changes" title="Show changes"
    aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
    <LuFileDiff aria-hidden="true" strokeWidth={1.5} />
  </button>;
}

type Space = { viewport: number; room: number; chat: number };

/** The chat's own width from its CSS rule (65vw by default, or the size the user dragged it to). */
function naturalChatWidth(body: HTMLElement) {
  const vw = window.innerWidth / 100;
  const stored = parseFloat(body.style.getPropertyValue("--right-size"));
  return clamp(Number.isFinite(stored) ? stored : 65 * vw, Math.min(230, 25 * vw), Math.min(75 * vw, window.innerWidth - 28 - 240));
}

/**
 * Open state, placement and width of the changes panel. On desktop widths the panel sits right of the
 * chat and pushes it left, narrowing the chat (to 340px at least) while open, also beside an open Inbox.
 * Only when even the minimum widths do not fit does it become a Changes tab over the chat dock; phones
 * get a full-screen version of those tabs.
 */
export function useDiffPanel(preferences: DiffPreferences, chatWindowRef: RefObject<HTMLElement | null>,
  active: boolean, inboxOpen: boolean) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"changes" | "chat">("changes");
  const [width, setWidth] = useState(() => preferences.readDiffWidth() ?? defaultWidth);
  const widthRef = useRef(width);
  const [space, setSpace] = useState<Space>({ viewport: window.innerWidth, room: Infinity, chat: 0 });
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; start: number; width: number } | null>(null);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useLayoutEffect(() => {
    const chat = chatWindowRef.current;
    const body = chat?.parentElement;
    if (!chat || !body) return;
    const measure = () => {
      const style = getComputedStyle(body);
      const inset = parseFloat(style.getPropertyValue("--window-inset")) || 0;
      const gap = parseFloat(style.getPropertyValue("--panel-gap")) || 0;
      // An open Inbox takes its own width and a gap out of the room for the chat and the panel.
      const inbox = document.getElementById("workspace-inbox-window");
      const inboxWidth = inboxOpen && inbox && !inbox.hidden ? inbox.getBoundingClientRect().width + gap : 0;
      const next = { viewport: window.innerWidth,
        room: body.getBoundingClientRect().width - 2 * inset - gap - Math.max(minMap, inboxWidth), chat: naturalChatWidth(body) };
      setSpace((current) => current.viewport === next.viewport && current.room === next.room && current.chat === next.chat
        ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(chat);
    const inbox = document.getElementById("workspace-inbox-window");
    if (inbox) observer.observe(inbox);
    // The chat's own resize handle changes this inline size.
    const mutations = new MutationObserver(measure);
    mutations.observe(body, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [chatWindowRef, inboxOpen]);

  const fits = space.room >= Math.min(space.chat, minChatWidth) + minWidth;
  const layout: DiffLayout = space.viewport <= 650 ? "overlay" : !fits ? "tabs" : "floating";
  // When the window or the Inbox takes away the room beside the chat, keep the chat in front instead of
  // covering it (and the composer focus) with the Changes tab.
  const [previousLayout, setPreviousLayout] = useState(layout);
  if (previousLayout !== layout) {
    setPreviousLayout(layout);
    if (previousLayout === "floating" && open) setTab("chat");
  }
  const maxWidth = Math.max(minWidth, space.room - Math.min(space.chat, minChatWidth));
  const shownWidth = clamp(width, minWidth, maxWidth);
  const chatWidth = (panel: number) => Math.max(Math.min(space.chat, minChatWidth), Math.min(space.chat, space.room - panel));

  const commitWidth = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
    preferences.writeDiffWidth(Math.round(next));
  }, [preferences]);

  function resizeHandle() {
    if (layout !== "floating") return null;
    const preview = (element: HTMLElement, next: number) => {
      const body = chatWindowRef.current?.parentElement;
      body?.style.setProperty("--diff-size", `${next}px`);
      body?.style.setProperty("--diff-chat-width", `${chatWidth(next)}px`);
      element.setAttribute("aria-valuenow", String(Math.round(next)));
    };
    return <div className="sw-diff-resize" role="separator" tabIndex={0} aria-label="Resize changes panel"
      aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={Math.round(maxWidth)}
      aria-valuenow={Math.round(shownWidth)}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, start: event.clientX, width: shownWidth };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        widthRef.current = clamp(current.width + current.start - event.clientX, minWidth, maxWidth);
        preview(event.currentTarget, widthRef.current);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setResizing(false);
        commitWidth(widthRef.current);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setResizing(false);
        commitWidth(widthRef.current);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 50 : 10;
        const next = { ArrowLeft: shownWidth + step, ArrowRight: shownWidth - step, Home: minWidth, End: maxWidth }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        commitWidth(clamp(next, minWidth, maxWidth));
      }} />;
  }

  const isOpen = open && active;
  // In the tab layouts the panel can stay open behind the chat tab.
  const showing = isOpen && (layout === "floating" || tab === "changes");
  const style = {
    "--diff-size": `${shownWidth}px`,
    ...(layout === "floating" && space.chat ? { "--diff-chat-width": `${chatWidth(shownWidth)}px` } : {}),
  } as CSSProperties;
  return {
    open: isOpen,
    /** The panel is visible rather than behind the chat tab. */
    showing,
    /** The chat dock is fully covered by the panel. */
    coversChat: isOpen && layout !== "floating" && tab === "changes",
    tab: layout === "floating" ? "changes" as const : tab,
    setTab,
    setOpen,
    toggle: () => {
      if (isOpen && !showing) setTab("changes");
      else if (isOpen) setOpen(false);
      else {
        setTab("changes");
        setOpen(true);
      }
    },
    layout,
    resizing,
    style,
    resizeHandle,
  };
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; diff: TaskDiff };

function shortRevision(revision: string) {
  return revision.slice(0, 7);
}

const statusNames = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed" } as const;
const modeNames = { automatic: "isolated worktree", worktree: "linked worktree", checkout: "local checkout" } as const;

function splitPath(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? { name: path, directory: "" } : { name: path.slice(index + 1), directory: path.slice(0, index + 1) };
}

function fileKey(group: DiffGroup, file: DiffFile) {
  return `${groupKey(group)}\0${file.path}`;
}

function groupKey(group: DiffGroup) {
  return `${group.projectId}\0${group.mode}\0${group.path ?? ""}`;
}

/** Names a location in the source picker and group titles: the local checkout, or a worktree by its branch or folder. */
function groupLabel(group: DiffGroup) {
  if (group.mode === "checkout") return `${group.projectId} · local checkout`;
  const place = group.branch ?? (group.path ? splitPath(group.path).name : undefined);
  return `${group.projectId} · ${place ? `${modeNames[group.mode]} ${place}` : modeNames[group.mode]}`;
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="sw-diff-counts">
    <span className="sw-diff-added">+{additions}</span> <span className="sw-diff-removed">−{deletions}</span>
  </span>;
}

function FileDiff({ group, file, id }: { group: DiffGroup; file: DiffFile; id: string }) {
  const { name, directory } = splitPath(file.path);
  const shownLines = file.lines.filter(([kind]) => kind !== "@").length;
  return <section className="sw-diff-file" id={id} aria-label={`${statusNames[file.status]} ${file.path}`}>
    <header className="sw-diff-file-header">
      <span className="sw-diff-status" data-status={file.status} title={statusNames[file.status]}>{file.status}</span>
      <span className="sw-diff-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.oldPath && <span className="sw-diff-dir">{file.oldPath} → </span>}
        <span className="sw-diff-dir">{directory}</span>{name}
      </span>
      {!file.binary && !file.skipped && <Counts additions={file.additions} deletions={file.deletions} />}
    </header>
    {file.skipped ? <p className="sw-diff-note">{file.skipped === "size"
      ? "Not shown. This untracked file is over the size limit."
      : "Not shown. There are too many untracked files to read."}</p>
      : file.binary ? <p className="sw-diff-note">Binary file not shown</p>
      : file.omitted ? <p className="sw-diff-note">Diff not loaded. This repository's changes exceed the display limit.</p>
      : !file.lines.length ? <p className="sw-diff-note">No content changes</p>
      : <div className="sw-diff-code" role="table" aria-label={`Diff of ${file.path}`}>
        {file.lines.map(([kind, text, oldLine, newLine], index) => kind === "@"
          ? <div key={index} className="sw-diff-line" data-kind="hunk" role="row">
            <span className="sw-diff-hunk" role="cell">{text}</span>
          </div>
          : <div key={index} className="sw-diff-line" data-kind={kind === "+" ? "add" : kind === "-" ? "del" : kind === "\\" ? "meta" : "context"} role="row">
            <span className="sw-diff-number" role="cell" aria-label={oldLine ? `Old line ${oldLine}` : undefined}>{oldLine ?? ""}</span>
            <span className="sw-diff-number" role="cell" aria-label={newLine ? `New line ${newLine}` : undefined}>{newLine ?? ""}</span>
            <span className="sw-diff-text" role="cell"><span className="sw-diff-sign" aria-hidden="true">{kind === "\\" ? "" : kind}</span>{text}</span>
          </div>)}
      </div>}
    {file.truncated && <p className="sw-diff-note">Diff truncated (first {shownLines} lines)</p>}
  </section>;
}

type TreeItem = {
  key: string; level: number; parent?: string; setSize: number; position: number;
  kind: "repo" | "dir" | "file"; name: string; group: DiffGroup; file?: DiffFile;
  additions: number; deletions: number; expandable: boolean;
};

function groupTree(group: DiffGroup) {
  return buildFileTree(group.files, (file) => fileKey(group, file), groupKey(group));
}

/** Visible rows of the repository and folder tree, flattened for rendering and keyboard navigation. */
function visibleItems(groups: DiffGroup[], collapsed: Set<string>) {
  const items: TreeItem[] = [];
  const walk = (nodes: FileTreeNode<DiffFile>[], group: DiffGroup, level: number, parent: string) => {
    nodes.forEach((node, index) => {
      const base = { level, parent, setSize: nodes.length, position: index + 1, group, name: node.name };
      if (node.kind === "file") {
        items.push({ ...base, key: node.key, kind: "file", file: node.file,
          additions: node.file.additions, deletions: node.file.deletions, expandable: false });
        return;
      }
      items.push({ ...base, key: node.key, kind: "dir", additions: node.additions, deletions: node.deletions, expandable: true });
      if (!collapsed.has(node.key)) walk(node.children, group, level + 1, node.key);
    });
  };
  groups.forEach((group, index) => {
    const key = groupKey(group);
    items.push({ key, level: 1, setSize: groups.length, position: index + 1, kind: "repo", name: groups.length > 1 ? groupLabel(group) : group.projectId, group,
      additions: group.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: group.files.reduce((sum, file) => sum + file.deletions, 0), expandable: true });
    if (!collapsed.has(key)) walk(groupTree(group), group, 2, key);
  });
  return items;
}

function FileTree({ groups, multiple, collapsed, onToggle, selected, onSelect }: {
  groups: DiffGroup[]; multiple: boolean; collapsed: Set<string>; onToggle: (key: string) => void;
  selected?: string; onSelect: (key: string) => void;
}) {
  const [focused, setFocused] = useState<string>();
  const tree = useRef<HTMLUListElement>(null);
  const items = useMemo(() => visibleItems(groups, collapsed), [collapsed, groups]);
  const active = items.some(({ key }) => key === focused) ? focused : selected && items.some(({ key }) => key === selected) ? selected : items[0]?.key;

  const pendingFocus = useRef<string>(undefined);
  const [focusRequest, setFocusRequest] = useState(0);
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = undefined;
    [...tree.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []].find((element) => element.dataset.key === key)?.focus();
  }, [focusRequest]);

  function move(key: string | undefined) {
    if (!key) return;
    setFocused(key);
    pendingFocus.current = key;
    setFocusRequest((count) => count + 1);
  }

  // Collapsing a folder that holds the focused row keeps focus on the folder.
  function toggle(key: string) {
    const collapsing = !collapsed.has(key);
    onToggle(key);
    if (collapsing && tree.current?.contains(document.activeElement)) move(key);
  }

  function activate(item: TreeItem) {
    setFocused(item.key);
    if (item.expandable) toggle(item.key);
    else onSelect(item.key);
  }

  function keyDown(event: KeyboardEvent<HTMLUListElement>) {
    const index = items.findIndex(({ key }) => key === active);
    const item = items[index];
    if (!item) return;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    const open = item.expandable && !collapsed.has(item.key);
    if (event.key === "ArrowDown") { handled(); move(items[Math.min(items.length - 1, index + 1)]?.key); }
    else if (event.key === "ArrowUp") { handled(); move(items[Math.max(0, index - 1)]?.key); }
    else if (event.key === "Home") { handled(); move(items[0]?.key); }
    else if (event.key === "End") { handled(); move(items.at(-1)?.key); }
    else if (event.key === "ArrowRight") {
      handled();
      if (item.expandable && !open) toggle(item.key);
      else if (open && items[index + 1]?.parent === item.key) move(items[index + 1].key);
    } else if (event.key === "ArrowLeft") {
      handled();
      if (open) toggle(item.key);
      else move(item.parent);
    } else if (event.key === "Enter" || event.key === " ") {
      handled();
      activate(item);
    }
  }

  return <ul ref={tree} className="sw-diff-tree" role="tree" aria-label="Changed files" onKeyDown={keyDown}>
    {items.map((item) => {
      const expanded = item.expandable ? !collapsed.has(item.key) : undefined;
      const Chevron = expanded ? LuChevronDown : LuChevronRight;
      const file = item.file;
      const label = item.kind === "repo" ? `${item.name}${multiple ? `, ${modeNames[item.group.mode]}` : ""}, ${item.additions} added, ${item.deletions} removed`
        : item.kind === "dir" ? `Folder ${item.name}, ${item.additions} added, ${item.deletions} removed`
        : `${statusNames[file!.status]} ${file!.path}, ${file!.binary ? "binary" : `${file!.additions} added, ${file!.deletions} removed`}`;
      return <li key={item.key} role="treeitem" aria-level={item.level} aria-setsize={item.setSize} aria-posinset={item.position}
        aria-expanded={expanded} aria-selected={item.kind === "file" ? selected === item.key : undefined}
        aria-label={label} data-key={item.key} data-kind={item.kind} tabIndex={active === item.key ? 0 : -1}
        onFocus={() => setFocused(item.key)} onClick={() => activate(item)}>
        <div className="sw-diff-tree-row" style={{ paddingLeft: 12 + (item.level - 1) * 14 }}
          title={file ? (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path) : undefined}>
          {item.expandable ? <Chevron className="sw-diff-chevron" aria-hidden="true" />
            : <span className="sw-diff-status" data-status={file!.status} aria-hidden="true">{file!.status}</span>}
          {item.kind === "repo" ? <><strong>{item.name}</strong>{multiple && <span className="sw-diff-dir">{modeNames[item.group.mode]}</span>}</>
            : <span className={`sw-diff-file-path${item.kind === "dir" ? " sw-diff-folder" : ""}`}>{item.name}</span>}
          <span className="sw-diff-tree-meta" aria-hidden="true">
            {file?.binary ? <span className="sw-diff-dir">bin</span> : file?.skipped ? <span className="sw-diff-dir">skipped</span> : <Counts additions={item.additions} deletions={item.deletions} />}
          </span>
        </div>
      </li>;
    })}
  </ul>;
}

function running(agent: WorkspaceAgent) {
  return agent.status === "working" || Boolean(agent.canCancel);
}

/** Read-only review of the files a task changed against the revision it started from. */
export function DiffPanel({ agent, open, layout, tab, onTab, resizing, resizeHandle, onClose }: {
  agent?: WorkspaceAgent; open: boolean; layout: DiffLayout; tab: "changes" | "chat"; onTab: (tab: "changes" | "chat") => void;
  resizing: boolean; resizeHandle: () => ReactNode; onClose: (restoreFocus: boolean) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [source, setSource] = useState("all");
  const request = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const agentId = agent?.id;

  const load = useCallback(async (reset: boolean) => {
    if (!agentId) return;
    const sequence = ++request.current;
    if (reset) setState({ status: "loading" });
    setRefreshing(true);
    try {
      const response = await fetch(`/api/diff?agentId=${encodeURIComponent(agentId)}`).catch(() => {
        throw new Error("The local Orchestra server is unreachable.");
      });
      const body = await response.json().catch(() => ({}));
      if (sequence !== request.current) return;
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The server could not compute the changes.");
      setState({ status: "ready", diff: body as TaskDiff });
    } catch (error) {
      if (sequence !== request.current) return;
      setState({ status: "error", message: error instanceof Error ? error.message : "The server could not compute the changes." });
    } finally {
      if (sequence === request.current) setRefreshing(false);
    }
  }, [agentId]);

  // Switching tasks starts over; reopening the panel refreshes in place.
  useEffect(() => {
    setSelected(undefined);
    setCollapsed(new Set());
    setSource("all");
    setState({ status: "loading" });
    request.current++;
  }, [agentId]);

  useEffect(() => {
    if (open) void load(false);
  }, [open, load]);

  // Refresh when a turn finishes or the task's edit destinations change, keeping the scroll position.
  const isRunning = agent ? running(agent) : false;
  const destinations = agent ? JSON.stringify([agent.candidate, agent.directCandidates, agent.scopedWorktrees, agent.checkoutEdits,
    agent.checkoutBases, agent.taskWorktrees, agent.directTask?.phase]) : "";
  const previous = useRef({ isRunning, destinations });
  useEffect(() => {
    const before = previous.current;
    previous.current = { isRunning, destinations };
    if (!open) return;
    if ((before.isRunning && !isRunning) || before.destinations !== destinations) void load(false);
  }, [open, isRunning, destinations, load]);

  function select(key: string) {
    setSelected(key);
    const target = [...scroller.current?.querySelectorAll<HTMLElement>("[data-file-key]") ?? []]
      .find((element) => element.dataset.fileKey === key);
    if (target && scroller.current) scroller.current.scrollTo({ top: target.offsetTop, behavior: "auto" });
  }

  const diff = state.status === "ready" ? state.diff : undefined;
  const allGroups = diff?.kind === "repositories" ? diff.groups : [];
  // With several locations, the picker shows one of them or all of them.
  const picked = allGroups.find((group) => groupKey(group) === source);
  const groups = picked ? [picked] : allGroups;
  const files = groups.flatMap(({ files }) => files);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const bases = [...new Set(groups.map(({ base }) => base))];
  const failed = groups.filter(({ error }) => error);

  let body: ReactNode;
  let tree: ReactNode;
  if (state.status === "loading") body = <p className="sw-diff-empty" role="status">Loading changes…</p>;
  else if (state.status === "error") {
    body = <div className="sw-diff-empty" role="alert">
      <p>Could not load changes. {state.message}</p>
      <button type="button" className="sw-diff-button" onClick={() => void load(false)}>Retry</button>
    </div>;
  } else if (diff?.kind === "general") body = <p className="sw-diff-empty">General chat — no repository changes</p>;
  else if (!groups.length) {
    // Tasks saved before Orchestra recorded checkout edits can have approved edits with nothing to diff.
    const approved = agent?.messages.some(({ implementationRequest }) => implementationRequest?.status === "approved");
    body = <p className="sw-diff-empty">{approved ? "No reviewable changes for this task." : "No changes yet."}</p>;
  }
  else {
    if (files.length) {
      tree = <FileTree groups={groups.filter((group) => group.files.length)}
        multiple={new Set(groups.map(({ projectId }) => projectId)).size !== groups.length}
        collapsed={collapsed} selected={selected} onSelect={select}
        onToggle={(key) => setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(key)) next.add(key);
          return next;
        })} />;
    }
    body = <>
      {failed.length > 0 && <div className="sw-diff-failure" role="alert">
        {failed.map((group) => <p key={groupKey(group)}><strong>{groupLabel(group)}</strong>: {group.error}</p>)}
        <button type="button" className="sw-diff-button" onClick={() => void load(false)}>Retry</button>
      </div>}
      {!files.length && !failed.length && <p className="sw-diff-empty">No changes yet.</p>}
      {groups.map((group) => group.files.length > 0 && <div key={groupKey(group)} className="sw-diff-group">
        {groups.length > 1 && <h3 className="sw-diff-group-title">
          {groupLabel(group)} <span className="sw-diff-dir">· base <code>{shortRevision(group.base)}</code></span>
        </h3>}
        {group.notices?.map((notice) => <p key={notice} className="sw-diff-note">{notice}</p>)}
        {group.mode === "checkout" && <p className="sw-diff-note">Edits in the local checkout. Uncommitted changes that were already there are included.</p>}
        {treeFiles(groupTree(group)).map((file) => {
          const key = fileKey(group, file);
          return <div key={key} data-file-key={key}><FileDiff group={group} file={file} id={`diff-${key}`} /></div>;
        })}
        {group.moreFiles ? <p className="sw-diff-note">{group.moreFiles} more changed files are not shown.</p> : null}
      </div>)}
    </>;
  }

  const covered = layout !== "floating" && tab === "chat";
  const changesTab = useRef<HTMLButtonElement>(null);
  // In the tab layouts the panel covers the chat, so focus moves into it when it appears.
  const visibleOverChat = open && layout !== "floating" && !covered;
  useEffect(() => {
    if (visibleOverChat) changesTab.current?.focus();
  }, [visibleOverChat]);

  return <aside ref={panel} id={panelId} className="sw-diff" data-layout={layout} data-tab={layout === "floating" ? undefined : tab}
    aria-label="Changes" hidden={!open} data-resizing={resizing || undefined}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      event.stopPropagation();
      onClose(true);
    }}>
    <div className="sw-diff-inner">
      {layout !== "floating" && <div className="sw-diff-tabs" role="tablist" aria-label="Chat view" onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = tab === "chat" ? "changes" : "chat";
        onTab(next);
        (event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`))?.focus();
      }}>
        <button type="button" role="tab" data-tab="chat" aria-selected={covered} tabIndex={covered ? 0 : -1}
          onClick={() => onTab("chat")}>Chat</button>
        <button ref={changesTab} type="button" role="tab" data-tab="changes" aria-selected={!covered} tabIndex={covered ? -1 : 0}
          aria-controls={`${panelId}-content`} onClick={() => onTab("changes")}>Changes</button>
      </div>}
      <div id={`${panelId}-content`} className="sw-diff-content" hidden={covered}>
      <header className="sw-diff-header">
        <div className="sw-diff-title">
          <h2>{bases.length === 1 ? <>Changes vs base <code>{shortRevision(bases[0])}</code></> : "Changes"}</h2>
          {files.length > 0 && <span className="sw-diff-summary">
            <Counts additions={additions} deletions={deletions} /> · {files.length} {files.length === 1 ? "file" : "files"}
          </span>}
        </div>
        <button type="button" className="interface-icon-button" aria-label="Close changes" title="Close changes"
          onClick={() => onClose(true)}>
          <LuX aria-hidden="true" strokeWidth={1.5} />
        </button>
      </header>
      {allGroups.length > 1 && <label className="sw-diff-source">
        <span>Location</span>
        <select value={picked ? source : "all"} onChange={(event) => {
          setSource(event.target.value);
          setSelected(undefined);
          scroller.current?.scrollTo({ top: 0 });
        }}>
          <option value="all">All locations ({allGroups.reduce((sum, group) => sum + group.files.length, 0)} files)</option>
          {allGroups.map((group) => <option key={groupKey(group)} value={groupKey(group)}>
            {groupLabel(group)} ({group.error ? "unavailable" : `${group.files.length} ${group.files.length === 1 ? "file" : "files"}`})
          </option>)}
        </select>
      </label>}
      {tree && <div className="sw-diff-tree-wrap">{tree}</div>}
      <div ref={scroller} className="sw-diff-body" aria-busy={refreshing}>{body}</div>
      </div>
    </div>
    {open && resizeHandle()}
  </aside>;
}
