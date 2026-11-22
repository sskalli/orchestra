import { useState } from "react";
import "./workspace-inbox.css";

export type InboxEvent = {
  id: string;
  agentName: string;
  status: string;
  tone: "working" | "attention" | "done" | "error" | "notice";
  text: string;
  agentId: string;
  messageId?: string;
};

type WorkspaceInboxProps = {
  events: InboxEvent[];
  onOpen: (agentId: string, messageId?: string) => void;
  onClose: () => void;
};

export function WorkspaceInbox({ events, onOpen, onClose }: WorkspaceInboxProps) {
  const [statusFilter, setStatusFilter] = useState("");
  const statuses = [...new Set([...events.map(({ status }) => status), ...(statusFilter ? [statusFilter] : [])])].sort();
  const visibleEvents = statusFilter ? events.filter(({ status }) => status === statusFilter) : events;

  return (
    <section className="workspace-chat workspace-inbox" aria-label="Inbox">
      <header className="chat-header">
        <div className="chat-header-copy"><h2>Inbox</h2></div>
        <button className="chat-icon-button" type="button" onClick={onClose} aria-label="Collapse inbox" title="Collapse inbox">
          <span aria-hidden="true">«</span>
        </button>
      </header>
      <div className="workspace-inbox-filter">
        <label htmlFor="inbox-status">Status</label>
        <select id="inbox-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </div>
      <div className="workspace-inbox-feed">
        {visibleEvents.length === 0 ? <p className="workspace-inbox-empty" role="status">
          {statusFilter ? "No tasks with this status." : "No task activity yet."}
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
    </section>
  );
}
