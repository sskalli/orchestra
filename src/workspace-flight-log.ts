import type { InboxEvent } from "./workspace-inbox.tsx";

type FlightLogEntry = { sequence: number; event: InboxEvent };

export type FlightLog = {
  entries: FlightLogEntry[];
  latest: Record<string, string>;
  sequence: number;
  archivedAgentIds: string[];
};

function isFlightLogEntry(value: unknown): value is FlightLogEntry {
  if (!value || typeof value !== "object") return false;
  const { sequence, event } = value as Partial<FlightLogEntry>;
  return Number.isSafeInteger(sequence) && !!event && typeof event.id === "string" &&
    typeof event.agentId === "string" && typeof event.agentName === "string" &&
    typeof event.status === "string" && typeof event.tone === "string" &&
    typeof event.text === "string" && (event.messageId === undefined || typeof event.messageId === "string");
}

function newestPerAgent(entries: FlightLogEntry[]) {
  const byAgent = new Map<string, FlightLogEntry>();
  for (const entry of entries) {
    const previous = byAgent.get(entry.event.agentId);
    if (!previous || entry.sequence > previous.sequence) byAgent.set(entry.event.agentId, entry);
  }
  return [...byAgent.values()].sort((left, right) => right.sequence - left.sequence);
}

export function readFlightLog(value: unknown): FlightLog {
  const saved = value as Partial<FlightLog> | null;
  const savedEntries = Array.isArray(saved?.entries) ? saved.entries.filter(isFlightLogEntry) : [];
  const entries = newestPerAgent(savedEntries);
  const latest = saved?.latest && typeof saved.latest === "object" && !Array.isArray(saved.latest)
    ? Object.fromEntries(Object.entries(saved.latest).filter(([, value]) => typeof value === "string"))
    : {};
  const baseSequence = typeof saved?.sequence === "number" && Number.isSafeInteger(saved.sequence) ? saved.sequence : 0;
  const sequence = savedEntries.reduce((max, item) => Math.max(max, item.sequence), baseSequence);
  const archivedAgentIds = Array.isArray(saved?.archivedAgentIds)
    ? saved.archivedAgentIds.filter((id) => typeof id === "string")
    : [];
  return { entries, latest, sequence, archivedAgentIds };
}

export function recordFlightLog(log: FlightLog, events: InboxEvent[], agents: { id: string; archivedAt?: number }[]): FlightLog {
  let sequence = log.sequence;
  const archivedAgentIds = agents.filter(({ archivedAt }) => archivedAt).map(({ id }) => id);
  const activeIds = new Set(agents.filter(({ archivedAt }) => !archivedAt).map(({ id }) => id));
  const previouslyArchived = new Set(log.archivedAgentIds);
  const entries = log.entries.filter(({ event }) => activeIds.has(event.agentId)).map((entry) =>
    entry.event.text ? { ...entry, event: { ...entry.event, text: "" } } : entry);
  // Streaming updates do not make an existing Working notification unread again.
  const latest = Object.fromEntries(events.map((event) =>
    [event.id, JSON.stringify([event.status, event.agentId, event.tone === "working" ? undefined : event.messageId])]));
  const newEntries = events.flatMap((event) => {
    if (latest[event.id] === log.latest[event.id] || (previouslyArchived.has(event.agentId) && !event.needsInput)) return [];
    return [{ sequence: ++sequence, event: { ...event, text: "" } }];
  });
  const currentEntries = newestPerAgent([...newEntries, ...entries]);
  const currentByAgent = new Map(currentEntries.map((entry) => [entry.event.agentId, entry]));
  const pending = events.filter((event) => event.needsInput && activeIds.has(event.agentId));
  const pendingIds = new Set(pending.map(({ id }) => id));
  const latestPendingByAgent = new Map(pending.map((event) => [event.agentId, event]));
  const fallbackEntries = [...latestPendingByAgent.values()].flatMap((event) => {
    const current = currentByAgent.get(event.agentId);
    if (current && pendingIds.has(current.event.id)) return [];
    return [{ sequence: ++sequence, event: { ...event, text: "" } }];
  });
  const updatedEntries = fallbackEntries.length
    ? newestPerAgent([...fallbackEntries, ...currentEntries])
    : currentEntries;
  const sameEntries = updatedEntries.length === log.entries.length &&
    updatedEntries.every((entry, index) => entry === log.entries[index]);
  const sameArchive = archivedAgentIds.length === log.archivedAgentIds.length && archivedAgentIds.every((id) => previouslyArchived.has(id));
  if (!newEntries.length && sameEntries && sameArchive &&
      Object.keys(latest).length === Object.keys(log.latest).length &&
      Object.entries(latest).every(([id, value]) => log.latest[id] === value)) return log;
  return { entries: updatedEntries, latest, sequence, archivedAgentIds };
}

export function clearFlightLog(log: FlightLog, pendingQuestionIds: ReadonlySet<string>): FlightLog {
  const retained = new Set<string>();
  const entries = log.entries.filter(({ event }) => {
    if (!pendingQuestionIds.has(event.id) || retained.has(event.id)) return false;
    retained.add(event.id);
    return true;
  });
  return { ...log, entries };
}

/** What the Inbox has not shown the user yet: an entry is seen once the Inbox was open or its task's chat was open. */
export function unreadInbox(log: FlightLog, readSequence: number, acknowledged: Readonly<Record<string, number>>,
  rootOf: (agentId: string) => string | undefined) {
  const alertedRoots = new Set<string>();
  let unread = false;
  for (const { sequence, event } of log.entries) {
    const root = rootOf(event.agentId);
    if (!root || sequence <= readSequence || sequence <= (acknowledged[root] ?? 0)) continue;
    unread = true;
    if (event.tone === "attention" || event.tone === "error") alertedRoots.add(root);
  }
  return { unread, alerts: alertedRoots.size };
}
