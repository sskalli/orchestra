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
const minWidth = 320;
const defaultWidth = 520;
const minMap = 160;

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

/**
 * Open state, placement and width of the changes panel. The panel floats left of the chat when the
 * map has room, becomes a tab over the chat dock on narrower windows or with the Inbox open, and
 * covers the workspace on phones.
 */
export function useDiffPanel(preferences: DiffPreferences, chatWindowRef: RefObject<HTMLElement | null>,
  active: boolean, inboxOpen: boolean) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(() => preferences.readDiffWidth() ?? defaultWidth);
  const widthRef = useRef(width);
  const [space, setSpace] = useState({ viewport: window.innerWidth, available: Infinity });
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
      const available = body.getBoundingClientRect().width - chat.getBoundingClientRect().width - 2 * inset - gap - minMap;
      setSpace((current) => current.viewport === window.innerWidth && current.available === available
        ? current : { viewport: window.innerWidth, available });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(chat);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [chatWindowRef]);

  const layout: DiffLayout = space.viewport <= 650 ? "overlay"
    : space.viewport < 1100 || inboxOpen || space.available < minWidth ? "tabs" : "floating";
  const maxWidth = Math.max(minWidth, space.available);
  const shownWidth = clamp(width, minWidth, maxWidth);

  const commitWidth = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
    preferences.writeDiffWidth(Math.round(next));
  }, [preferences]);

  function resizeHandle() {
    if (layout !== "floating") return null;
    const preview = (element: HTMLElement, next: number) => {
      chatWindowRef.current?.parentElement?.style.setProperty("--diff-size", `${next}px`);
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

  const style = { "--diff-size": `${shownWidth}px` } as CSSProperties;
  return {
    open: open && active,
    setOpen,
    toggle: () => setOpen((current) => !current),
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
  return `${group.projectId}\0${group.mode}\0${file.path}`;
}

function groupKey(group: DiffGroup) {
  return `${group.projectId}\0${group.mode}`;
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
      {!file.binary && <Counts additions={file.additions} deletions={file.deletions} />}
    </header>
    {file.binary ? <p className="sw-diff-note">Binary file not shown</p>
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
    items.push({ key, level: 1, setSize: groups.length, position: index + 1, kind: "repo", name: group.projectId, group,
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

  function activate(item: TreeItem) {
    setFocused(item.key);
    if (item.expandable) onToggle(item.key);
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
      if (item.expandable && !open) onToggle(item.key);
      else if (open && items[index + 1]?.parent === item.key) move(items[index + 1].key);
    } else if (event.key === "ArrowLeft") {
      handled();
      if (open) onToggle(item.key);
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
            {file?.binary ? <span className="sw-diff-dir">bin</span> : <Counts additions={item.additions} deletions={item.deletions} />}
          </span>
        </div>
      </li>;
    })}
  </ul>;
}

function running(agent: WorkspaceAgent) {
  return agent.status === "working" || Boolean(agent.canCancel) || agent.directTask?.phase === "implementing";
}

/** Read-only review of the files a task changed against the revision it started from. */
export function DiffPanel({ agent, open, layout, resizing, resizeHandle, onClose }: {
  agent?: WorkspaceAgent; open: boolean; layout: DiffLayout; resizing: boolean;
  resizeHandle: () => ReactNode; onClose: (restoreFocus: boolean) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
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
    setState({ status: "loading" });
    request.current++;
  }, [agentId]);

  useEffect(() => {
    if (open) void load(false);
  }, [open, load]);

  // Refresh when a turn finishes or the task's edit destinations change, keeping the scroll position.
  const isRunning = agent ? running(agent) : false;
  const destinations = agent ? JSON.stringify([agent.candidate, agent.directCandidates, agent.scopedWorktrees, agent.checkoutEdits, agent.directTask?.phase]) : "";
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
  const groups = diff?.kind === "repositories" ? diff.groups : [];
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
  else if (!groups.length) body = <p className="sw-diff-empty">No changes yet. Edits start after Allow edits.</p>;
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
        {failed.map((group) => <p key={groupKey(group)}><strong>{group.projectId}</strong>: {group.error}</p>)}
        <button type="button" className="sw-diff-button" onClick={() => void load(false)}>Retry</button>
      </div>}
      {!files.length && !failed.length && <p className="sw-diff-empty">No changes yet.</p>}
      {groups.map((group) => group.files.length > 0 && <div key={groupKey(group)} className="sw-diff-group">
        {groups.length > 1 && <h3 className="sw-diff-group-title">
          {group.projectId} <span className="sw-diff-dir">· {modeNames[group.mode]} · base <code>{shortRevision(group.base)}</code></span>
        </h3>}
        {group.mode === "checkout" && <p className="sw-diff-note">Edits in the local checkout. Uncommitted changes that were already there are included.</p>}
        {treeFiles(groupTree(group)).map((file) => {
          const key = fileKey(group, file);
          return <div key={key} data-file-key={key}><FileDiff group={group} file={file} id={`diff-${key}`} /></div>;
        })}
        {group.moreFiles ? <p className="sw-diff-note">{group.moreFiles} more changed files are not shown.</p> : null}
      </div>)}
    </>;
  }

  return <aside ref={panel} id={panelId} className="sw-diff" data-layout={layout} aria-label="Changes" hidden={!open}
    data-resizing={resizing || undefined}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      event.stopPropagation();
      onClose(true);
    }}>
    <div className="sw-diff-inner">
      {layout !== "floating" && <div className="sw-diff-tabs" role="tablist" aria-label="Chat view">
        <button type="button" role="tab" aria-selected={false} onClick={() => onClose(true)}>Chat</button>
        <button type="button" role="tab" aria-selected={true} tabIndex={-1}>Changes</button>
      </div>}
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
      {tree && <div className="sw-diff-tree-wrap">{tree}</div>}
      <div ref={scroller} className="sw-diff-body" aria-busy={refreshing}>{body}</div>
    </div>
    {open && resizeHandle()}
  </aside>;
}
