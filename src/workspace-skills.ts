// Skills (and slash commands) that the current engine offers for "/" autocomplete in the composer.

export type WorkspaceSkill = { name: string; description: string; argumentHint?: string; path?: string };

/** The `skills/list` response shape of the Codex App Server, which the Claude engine also returns. */
type ProviderSkill = {
  name?: unknown; description?: unknown; shortDescription?: unknown; argumentHint?: unknown; path?: unknown; enabled?: unknown;
  interface?: { shortDescription?: unknown } | null;
};
export type ProviderSkillsResponse = { data?: { skills?: ProviderSkill[] }[] };

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const validName = /^[\w.:-]+$/;

/** Flattens per-directory skill lists, drops disabled entries, and keeps the first skill of each name. */
export function normalizeSkills(response: ProviderSkillsResponse | undefined): WorkspaceSkill[] {
  const skills = new Map<string, WorkspaceSkill>();
  for (const entry of response?.data ?? []) {
    for (const skill of entry.skills ?? []) {
      const name = text(skill.name);
      if (!validName.test(name) || skill.enabled === false || skills.has(name)) continue;
      const description = text(skill.interface?.shortDescription) || text(skill.shortDescription) || text(skill.description);
      const argumentHint = text(skill.argumentHint);
      const path = text(skill.path);
      skills.set(name, { name, description, ...(argumentHint ? { argumentHint } : {}), ...(path ? { path } : {}) });
    }
  }
  return [...skills.values()];
}

/**
 * Codex passes "/name" through as plain text; it runs a skill when the input carries a skill item.
 * Returns that item when the message starts with "/name" for a listed skill that has a path.
 */
export function skillInputFor(message: string, skills: readonly WorkspaceSkill[] | undefined) {
  const name = /^\/([\w.:-]+)(?=\s|$)/.exec(message)?.[1];
  const skill = name ? skills?.find((entry) => entry.name === name && entry.path) : undefined;
  return skill ? [{ type: "skill", name: skill.name, path: skill.path! }] : [];
}

const cacheMs = 60_000;

/** Caches the engine's skill list briefly, since listing Claude skills starts a Claude Code process. */
export class SkillCatalog {
  private skills?: WorkspaceSkill[];
  private loadedAt = 0;
  private loading?: Promise<WorkspaceSkill[]>;
  private generation = 0;
  private readonly load: () => Promise<WorkspaceSkill[]>;
  private readonly now: () => number;

  constructor(load: () => Promise<WorkspaceSkill[]>, now = Date.now) {
    this.load = load;
    this.now = now;
  }

  /** The last list that loaded, however old, for matching sent messages without waiting. */
  get known() {
    return this.skills;
  }

  /** Forgets the cached list's freshness, for example after the provider reports changed skill files. */
  invalidate() {
    this.loadedAt = 0;
    this.generation++;
    this.loading = undefined;
  }

  list(): Promise<WorkspaceSkill[]> {
    if (this.skills && this.now() - this.loadedAt < cacheMs) return Promise.resolve(this.skills);
    if (this.loading) return this.loading;
    const generation = this.generation;
    const loading = this.load().then((skills) => {
      if (generation === this.generation) {
        this.skills = skills;
        this.loadedAt = this.now();
      }
      return skills;
    }).finally(() => {
      if (this.loading === loading) this.loading = undefined;
    });
    this.loading = loading;
    return loading;
  }
}

export const demoSkills: WorkspaceSkill[] = [
  { name: "code-review", description: "Review the current diff for correctness bugs", argumentHint: "[target]" },
  { name: "simplify", description: "Review changed code for reuse and simplification, then apply fixes" },
  { name: "security-review", description: "Complete a security review of the pending changes" },
  { name: "init", description: "Initialize a CLAUDE.md file with codebase documentation" },
  { name: "pdf", description: "Read, create, and verify PDF files" },
  { name: "release-notes", description: "Draft release notes from merged changes", argumentHint: "<version>" },
];
