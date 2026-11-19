import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const tokenFields = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
type TokenField = typeof tokenFields[number];
export type UsageTokens = Record<TokenField, number> & { cacheWriteInputTokens?: number };
export type UsageAttribution = { agentId: string; runId?: string; teamId?: string; model?: string };
export type DelegationDecision = {
  id: string;
  at: number;
  agentId: string;
  runId?: string;
  teamId?: string;
  delegateId?: string;
  duty?: string;
  complexity?: string;
  model?: string;
  reason: string;
  outcome?: "queued" | "started" | "failed" | "uncertain";
};
type UsageThread = {
  id: string;
  agentId?: string;
  total: UsageTokens | null;
  incompleteTurnId?: string;
  checkpointTurnId?: string;
  unattributedTokens?: UsageTokens;
};
export type UsageTurn = {
  threadId: string;
  turnId: string;
  attribution?: UsageAttribution;
  tokens: UsageTokens | null;
  partial: boolean;
};
export type UsageTotals = {
  tokens: UsageTokens | null;
  observedTurns: number;
  partialTurns: number;
  unknownTurns: number;
};
export type UsageSummary = {
  total: UsageTotals;
  byAgent: Record<string, UsageTotals>;
  byTeam: Record<string, UsageTotals>;
  byRun: Record<string, UsageTotals>;
  unattributedTokens: UsageTokens | null;
};
export type UsageSnapshot = UsageSummary & { turns: UsageTurn[]; decisions: DelegationDecision[] };

const zero = (): UsageTokens => ({
  totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
});
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

function readTokens(payload: unknown): UsageTokens | undefined {
  if (typeof payload !== "object" || !payload) return;
  const fields = payload as Record<string, unknown>;
  const result = zero();
  for (const key of tokenFields) {
    const count = fields[key];
    if (!validCount(count)) return;
    result[key] = count;
  }
  if (validCount(fields.cacheWriteInputTokens)) result.cacheWriteInputTokens = fields.cacheWriteInputTokens;
  return result;
}

function delta(next: UsageTokens, previous: UsageTokens): UsageTokens | undefined {
  if (next.totalTokens <= previous.totalTokens) return;
  const result = zero();
  for (const key of tokenFields) {
    if (next[key] < previous[key]) return;
    result[key] = next[key] - previous[key];
  }
  if (next.cacheWriteInputTokens !== undefined &&
      next.cacheWriteInputTokens >= (previous.cacheWriteInputTokens ?? 0)) {
    result.cacheWriteInputTokens = next.cacheWriteInputTokens - (previous.cacheWriteInputTokens ?? 0);
  }
  return result;
}

function addTokens(a: UsageTokens | null, b: UsageTokens): UsageTokens {
  const result = zero();
  for (const field of tokenFields) result[field] = (a?.[field] ?? 0) + b[field];
  if (a?.cacheWriteInputTokens !== undefined || b.cacheWriteInputTokens !== undefined) {
    result.cacheWriteInputTokens = (a?.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0);
  }
  return result;
}

const emptyTotals = (): UsageTotals => ({ tokens: null, observedTurns: 0, partialTurns: 0, unknownTurns: 0 });
function addTurn(totals: UsageTotals, turn: UsageTurn) {
  if (turn.tokens) {
    totals.tokens = addTokens(totals.tokens, turn.tokens);
    if (turn.partial) totals.partialTurns++;
    else totals.observedTurns++;
  } else {
    totals.unknownTurns++;
  }
}

export class WorkspaceUsage {
  private readonly threads = new Map<string, UsageThread>();
  private readonly turns = new Map<string, UsageTurn>();
  private readonly decisions = new Map<string, DelegationDecision>();
  private readonly resumedThreads = new Map<string, string | undefined>();
  private summaryCache?: UsageSummary;
  private dirty = false;

  private readonly path?: string;

  constructor(path?: string) {
    this.path = path;
    if (!path) return;
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const saved = JSON.parse(contents);
    if (saved?.version !== 1 || !Array.isArray(saved.threads) ||
        !Array.isArray(saved.turns) || !Array.isArray(saved.decisions)) {
      throw new Error("Orchestra could not read the saved usage format.");
    }
    for (const thread of saved.threads as UsageThread[]) {
      if (!validId(thread?.id) || this.threads.has(thread.id) || (thread.total !== null && !readTokens(thread.total)) ||
          (thread.unattributedTokens && !readTokens(thread.unattributedTokens))) {
        throw new Error("Orchestra could not read a saved usage checkpoint.");
      }
      this.threads.set(thread.id, thread);
    }
    for (const turn of saved.turns as UsageTurn[]) {
      if (!validId(turn?.turnId) || !this.threads.has(turn.threadId) || typeof turn.partial !== "boolean" ||
          (turn.attribution && !validId(turn.attribution.agentId)) || (turn.tokens !== null && !readTokens(turn.tokens))) {
        throw new Error("Orchestra could not read a saved usage turn.");
      }
      this.turns.set(turnKey(turn.threadId, turn.turnId), turn);
    }
    for (const decision of saved.decisions as DelegationDecision[]) {
      if (!validId(decision?.id) || !validId(decision.agentId) || typeof decision.reason !== "string") {
        throw new Error("Orchestra could not read a saved delegation decision.");
      }
      this.decisions.set(decision.id, decision);
    }
  }

  registerThread(threadId: string, fresh: boolean, agentId?: string) {
    if (!validId(threadId)) return;
    const current = this.threads.get(threadId);
    if (!current || (!current.agentId && validId(agentId))) {
      this.threads.set(threadId, current ? { ...current, agentId } : {
        id: threadId, ...(validId(agentId) && { agentId }), total: fresh ? zero() : null,
      });
      this.changed();
    }
  }

  registerTurn(threadId: string, turnId: string, attribution: UsageAttribution, recovered = false) {
    const thread = this.threads.get(threadId);
    if (!thread || !validId(turnId) || !validId(attribution.agentId)) return;
    const key = turnKey(threadId, turnId);
    const turn = this.turns.get(key);
    if (!recovered && this.resumedThreads.has(threadId)) {
      if (thread.checkpointTurnId === turnId) this.resumedThreads.delete(threadId);
      else this.resumedThreads.set(threadId, turnId);
    }
    if (turn?.attribution) return;
    this.turns.set(key, {
      threadId, turnId, attribution: { ...attribution }, tokens: turn?.tokens ?? null,
      partial: turn?.partial ?? (thread.incompleteTurnId === turnId),
    });
    this.changed();
  }

  markResumedThread(threadId: string, interruptedTurnId?: string) {
    this.resumedThreads.set(threadId, undefined);
    if (!interruptedTurnId) return;
    const turn = this.turns.get(turnKey(threadId, interruptedTurnId));
    if (!turn || turn.partial) return;
    turn.partial = true;
    this.changed();
  }

  observe(threadId: string, turnId: string, payload: unknown) {
    const thread = this.threads.get(threadId);
    if (!thread || !validId(turnId) || typeof payload !== "object" || !payload) return;
    const update = payload as { total?: unknown; last?: unknown };
    const total = readTokens(update.total);
    if (!total) return;

    const key = turnKey(threadId, turnId);
    const turn = this.turns.get(key);
    if (!thread.total) {
      thread.total = total;
      thread.incompleteTurnId = turnId;
      this.advanceCheckpoint(thread, turnId);
      if (turn) turn.partial = true;
      this.changed();
      return;
    }

    const additional = delta(total, thread.total);
    if (!additional) return;
    thread.total = total;
    const observed = turn ?? { threadId, turnId, tokens: null, partial: thread.incompleteTurnId === turnId };
    // A new turn's cumulative delta may include an earlier turn's missing usage.
    const hasCoverageGap = this.hasCoverageGap(thread, turnId);
    this.advanceCheckpoint(thread, turnId);
    const last = hasCoverageGap ? readTokens(update.last) : undefined;
    if (hasCoverageGap && (!last || !tokenFields.every((field) => last[field] === additional[field]) ||
        (last.cacheWriteInputTokens ?? 0) !== (additional.cacheWriteInputTokens ?? 0))) {
      const usableLast = last && last.totalTokens < additional.totalTokens &&
        tokenFields.every((field) => last[field] <= additional[field]) &&
        (last.cacheWriteInputTokens ?? 0) <= (additional.cacheWriteInputTokens ?? 0) ? last : undefined;
      const remainder = usableLast ? delta(additional, usableLast)! : additional;
      thread.unattributedTokens = addTokens(thread.unattributedTokens ?? null, remainder);
      if (usableLast?.totalTokens) observed.tokens = addTokens(observed.tokens, usableLast);
      observed.partial = true;
    } else {
      observed.tokens = addTokens(observed.tokens, additional);
    }
    this.turns.set(key, observed);
    this.changed();
  }

  private advanceCheckpoint(thread: UsageThread, turnId: string) {
    thread.checkpointTurnId = turnId;
    if (this.resumedThreads.get(thread.id) === turnId) this.resumedThreads.delete(thread.id);
  }

  private hasCoverageGap(thread: UsageThread, turnId: string) {
    if (turnId === thread.checkpointTurnId) return false;
    // Resume can replay a checkpoint without proving that the previous turn's usage is complete.
    if (this.resumedThreads.has(thread.id)) return true;
    let gap = false;
    for (const turn of this.turns.values()) {
      if (turn.threadId !== thread.id) continue;
      if (turn.turnId === turnId) break;
      if (turn.turnId === thread.checkpointTurnId) gap = false;
      else if (turn.attribution && !turn.tokens) gap = true;
    }
    return gap;
  }

  recordDecision(decision: DelegationDecision) {
    if (!validId(decision.id) || !validId(decision.agentId) || this.decisions.has(decision.id)) return;
    this.decisions.set(decision.id, { ...decision });
    this.changed();
  }

  removeAgents(agentIds: readonly string[]) {
    const ids = new Set(agentIds);
    this.removeWhere((id) => ids.has(id));
  }

  retainAgents(agentIds: readonly string[]) {
    const ids = new Set(agentIds);
    this.removeWhere((id) => !ids.has(id));
  }

  private removeWhere(remove: (id: string) => boolean) {
    const removedThreads = new Set<string>();
    let removed = false;
    for (const [id, thread] of this.threads) {
      if (thread.agentId && remove(thread.agentId)) {
        removedThreads.add(id);
        this.threads.delete(id);
        this.resumedThreads.delete(id);
        removed = true;
      }
    }
    for (const [id, turn] of this.turns) {
      if (removedThreads.has(turn.threadId) || (turn.attribution && remove(turn.attribution.agentId))) {
        this.turns.delete(id);
        removed = true;
      }
    }
    for (const [id, decision] of this.decisions) {
      if (remove(decision.agentId) || (decision.delegateId && remove(decision.delegateId))) {
        this.decisions.delete(id);
        removed = true;
      }
    }
    if (removed) this.changed();
    else this.flush();
  }

  summary(): UsageSummary {
    if (this.summaryCache) return this.summaryCache;
    const total = emptyTotals();
    const byAgent: UsageSummary["byAgent"] = Object.create(null);
    const byTeam: UsageSummary["byTeam"] = Object.create(null);
    const byRun: UsageSummary["byRun"] = Object.create(null);
    let unattributedTokens: UsageTokens | null = null;
    for (const turn of this.turns.values()) {
      addTurn(total, turn);
      const attribution = turn.attribution;
      if (!attribution) {
        if (turn.tokens) unattributedTokens = addTokens(unattributedTokens, turn.tokens);
        continue;
      }
      addTurn(byAgent[attribution.agentId] ??= emptyTotals(), turn);
      if (attribution.teamId) addTurn(byTeam[attribution.teamId] ??= emptyTotals(), turn);
      if (attribution.runId) addTurn(byRun[attribution.runId] ??= emptyTotals(), turn);
    }
    for (const thread of this.threads.values()) {
      if (!thread.unattributedTokens) continue;
      unattributedTokens = addTokens(unattributedTokens, thread.unattributedTokens);
      total.tokens = addTokens(total.tokens, thread.unattributedTokens);
    }
    return this.summaryCache = { total, byAgent, byTeam, byRun, unattributedTokens };
  }

  snapshot(): UsageSnapshot {
    return {
      ...structuredClone(this.summary()), turns: structuredClone([...this.turns.values()]),
      decisions: structuredClone([...this.decisions.values()]),
    };
  }

  private changed() {
    this.summaryCache = undefined;
    this.dirty = true;
    this.flush();
  }

  private flush() {
    if (!this.path || !this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({
        version: 1, threads: [...this.threads.values()], turns: [...this.turns.values()], decisions: [...this.decisions.values()],
      }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      this.dirty = false;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
