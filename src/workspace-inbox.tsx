import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LuListFilter, LuMinus, LuTrash2 } from "react-icons/lu";
import "./workspace-inbox.css";

export type InboxEvent = {
  id: string;
  agentName: string;
  status: string;
  tone: "working" | "attention" | "done" | "error" | "notice";
  text: string;
  agentId: string;
  messageId?: string;
  needsInput?: boolean;
};

type WorkspaceInboxProps = {
  events: InboxEvent[];
  toggle?: ReactNode;
  onOpen: (agentId: string, messageId?: string) => void;
  onClose: () => void;
  onClear: () => void;
  canClear: boolean;
};

export function WorkspaceInbox({ events, toggle, onOpen, onClose, onClear, canClear }: WorkspaceInboxProps) {
  const feed = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const filters = useRef<HTMLDivElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filter, setFilter] = useState<Pick<InboxEvent, "status" | "tone">>();
  const statusFilter = filter?.status ?? "";
  const tones = new Map(events.map(({ status, tone }) => [status, tone]));
  if (filter && !tones.has(filter.status)) tones.set(filter.status, filter.tone);
  const statuses = [...tones.keys()].sort();
  const filteredEvents = statusFilter ? events.filter(({ status }) => status === statusFilter) : events;
  // Keep the feed chronological (oldest → newest) so recent updates stay at the bottom like chat.
  const orderedEvents = [...filteredEvents].sort((left, right) => {
    const leftSequence = Number(left.id);
    const rightSequence = Number(right.id);
    if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) return leftSequence - rightSequence;
    return 0;
  });
  const visibleEvents = orderedEvents.reduce<InboxEvent[]>((list, event) => {
    const previous = list.at(-1);
    if (event.tone === "working" && previous?.tone === "working" && previous.agentId === event.agentId) {
      list[list.length - 1] = event;
      return list;
    }
    list.push(event);
    return list;
  }, []);

  function scrollToLatest() {
    if (!feed.current) return;
    followLatest.current = true;
    feed.current.scrollTop = feed.current.scrollHeight;
    setShowJumpToLatest(false);
  }

  const syncScroll = useCallback(() => {
    const element = feed.current;
    if (!element?.clientHeight) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
    followLatest.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }, []);

  useLayoutEffect(() => {
    const element = feed.current;
    const rows = content.current;
    if (!element || !rows) return;
    const observer = new ResizeObserver(syncScroll);
    observer.observe(element);
    observer.observe(rows);
    return () => observer.disconnect();
  }, [syncScroll]);

  useLayoutEffect(() => {
    if (followLatest.current) scrollToLatest();
  }, [events, statusFilter]);

  useEffect(() => {
    if (!filtersOpen) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !filters.current?.contains(event.target)) setFiltersOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [filtersOpen]);

  return (
    <section className="workspace-chat workspace-inbox" aria-label="Inbox">
      <header className="chat-header">
        {toggle}
        <div className="chat-header-copy"><h2>Inbox</h2></div>
        <div ref={filters} className="workspace-inbox-filter" onKeyDown={(event) => {
          if (event.key === "Escape" && filtersOpen) {
            event.stopPropagation();
            setFiltersOpen(false);
            filterButton.current?.focus();
          }
        }}>
          <button ref={filterButton} className="interface-icon-button workspace-inbox-filter-toggle" type="button"
            aria-label="Filter by status" title="Filter by status"
            aria-expanded={filtersOpen} aria-controls="inbox-filter" data-active={Boolean(statusFilter)}
            onClick={() => setFiltersOpen((open) => !open)}>
            <LuListFilter aria-hidden="true" strokeWidth={1.5} />
          </button>
          <div className="workspace-inbox-filter-options" id="inbox-filter" role="group" aria-label="Status filters" hidden={!filtersOpen}>
            {["", ...statuses].map((status) => <button type="button" key={status} aria-pressed={statusFilter === status}
              onClick={() => {
                scrollToLatest();
                const tone = tones.get(status);
                setFilter(tone ? { status, tone } : undefined);
                setFiltersOpen(false);
                filterButton.current?.focus();
              }}>
              <span className={status ? `workspace-inbox-filter-color is-${tones.get(status)}` : "workspace-inbox-filter-all"}>
                {status || "All statuses"}
              </span>
            </button>)}
          </div>
        </div>
        <button className="chat-icon-button" type="button" disabled={!canClear} aria-label="Clear Inbox history"
          title="Clear history and keep pending questions" onClick={onClear}>
          <LuTrash2 aria-hidden="true" />
        </button>
        <button className="interface-icon-button" type="button" onClick={onClose}
          aria-label="Minimize agent inbox" title="Minimize agent inbox">
          <LuMinus aria-hidden="true" strokeWidth={1.5} />
        </button>
      </header>
      <div className="chat-transcript-wrap">
        <div className="workspace-inbox-feed" ref={feed} tabIndex={-1} onScroll={syncScroll}>
          <div ref={content}>
            {visibleEvents.length === 0 ? <p className="workspace-inbox-empty" role="status">
              {statusFilter ? "No tasks with this status." : "No activity in the Inbox."}
            </p> : (
              <ul className="workspace-inbox-events" aria-label="Task activity">
                {visibleEvents.map(({ id, agentName, status, tone, text, agentId, messageId }) => (
                  <li key={id} className="workspace-inbox-event">
                    <details className="workspace-inbox-details">
                      <summary>
                        <span className="workspace-inbox-name" title={agentName}>{agentName}</span>
                        <strong className={`workspace-inbox-status is-${tone}`}>{status}</strong>
                      </summary>
                      <div className="workspace-inbox-preview">
                        {text && <p>{text}</p>}
                        <button type="button" onClick={() => onOpen(agentId, messageId)}>Open conversation</button>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {showJumpToLatest && <button className="chat-jump-latest" type="button"
          aria-label="Jump to latest notification" title="Jump to latest notification" onClick={() => {
            feed.current?.focus({ preventScroll: true });
            scrollToLatest();
          }}>
          <span aria-hidden="true">↓</span>
        </button>}
      </div>
    </section>
  );
}
