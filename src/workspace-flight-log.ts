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

export function readFlightLog(value: unknown): FlightLog {
  const saved = value as Partial<FlightLog> | null;
  const entries = Array.isArray(saved?.entries) ? saved.entries.filter(isFlightLogEntry) : [];
  const latest = saved?.latest && typeof saved.latest === "object" && !Array.isArray(saved.latest)
    ? Object.fromEntries(Object.entries(saved.latest).filter(([, value]) => typeof value === "string"))
    : {};
  const baseSequence = typeof saved?.sequence === "number" && Number.isSafeInteger(saved.sequence) ? saved.sequence : 0;
  const sequence = entries.reduce((max, item) => Math.max(max, item.sequence), baseSequence);
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
  const latest = Object.fromEntries(events.map((event) => {
    const previous = log.latest[event.id];
    const identity = JSON.stringify([event.status, event.agentId]);
    // A working session can publish several messages before its status changes.
    // Keep its current signature, including signatures saved by earlier versions.
    if (event.tone === "working" && previous?.startsWith(identity.slice(0, -1) + ",")) {
      return [event.id, previous];
    }
    return [event.id, JSON.stringify([event.status, event.agentId, event.messageId])];
  }));
  const newEntries = events.flatMap((event) => {
    if (latest[event.id] === log.latest[event.id] || (previouslyArchived.has(event.agentId) && !event.needsInput)) return [];
    return [{ sequence: ++sequence, event: { ...event, text: "" } }];
  });
  const sameEntries = entries.length === log.entries.length && entries.every((entry, index) => entry === log.entries[index]);
  const sameArchive = archivedAgentIds.length === log.archivedAgentIds.length && archivedAgentIds.every((id) => previouslyArchived.has(id));
  if (!newEntries.length && sameEntries && sameArchive &&
      Object.keys(latest).length === Object.keys(log.latest).length &&
      Object.entries(latest).every(([id, value]) => log.latest[id] === value)) return log;
  return { entries: [...newEntries.reverse(), ...entries], latest, sequence, archivedAgentIds };
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
