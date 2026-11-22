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
  return (
    <section className="workspace-chat workspace-inbox" aria-label="Inbox">
      <header className="chat-header">
        <div className="chat-header-copy"><h2>Inbox</h2></div>
        <button className="chat-icon-button" type="button" onClick={onClose} aria-label="Collapse inbox" title="Collapse inbox">
          <span aria-hidden="true">«</span>
        </button>
      </header>
      <div className="workspace-inbox-feed">
        {events.length === 0 ? <p className="workspace-inbox-empty">No task activity yet.</p> : (
          <ul className="workspace-inbox-events" aria-label="Task activity">
            {events.map(({ id, agentName, status, tone, text, agentId, messageId }) => (
              <li key={id} className="workspace-inbox-event">
                <div className="workspace-inbox-heading">
                  <span>{agentName}</span>
                  <span aria-hidden="true"> · </span>
                  <strong className={`workspace-inbox-status is-${tone}`}>{status}</strong>
                </div>
                <details className="workspace-inbox-details">
                  <summary>Details</summary>
                  {text && <p>{text}</p>}
                  <button type="button" onClick={() => onOpen(agentId, messageId)}>Open conversation</button>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
