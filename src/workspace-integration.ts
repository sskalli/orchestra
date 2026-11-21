import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFeatureWorktree, removeFeatureWorktree } from "./workspace-worktree.ts";

export type IntegrationSource = { agentId: string; path: string; base: string; submissionId: string; expectedFingerprint: string };
export type IntegrationMember = { projectId: string; path: string; base: string; fingerprint: string; revision?: string };
type ProjectSource = IntegrationSource & { projectId: string };
type ProjectIntegration = Omit<IntegrationMember, "projectId"> & {
  members?: IntegrationMember[];
  sources: { agentId: string; submissionId: string; head: string; fingerprint: string; projectId?: string }[];
};

// Git operates only on app-owned candidate metadata. Never inherit a caller's
// GIT_INDEX_FILE/GIT_DIR, and never run repository hooks or signing programs.
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
function git(cwd: string, args: string[], overrides: Record<string, string> = {}) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: { ...cleanEnvironment(), ...overrides }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(path: string) {
  const root = realpathSync(path);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error("Integration requires a complete Git worktree, not a subdirectory.");
  }
  return { root, common: realpathSync(resolve(root, git(root, ["rev-parse", "--git-common-dir"]))) };
}

function snapshot(path: string) {
  const head = git(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const temporary = mkdtempSync(join(tmpdir(), "orchestra-index-"));
  const env = { GIT_INDEX_FILE: join(temporary, "index") };
  try {
    git(path, ["read-tree", head], env);
    git(path, ["add", "-A", "--", "."], env);
    const tree = git(path, ["write-tree"], env);
    if (git(path, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head) {
      throw new Error("The candidate changed while its snapshot was being prepared. Retry after work stops.");
    }
    return { head, tree, fingerprint: createHash("sha256").update(head + "\n" + tree).digest("hex") };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Current checked-out contents, including untracked files that Git does not ignore. */
export function fingerprintCandidate(path: string) {
  return snapshot(repository(path).root).fingerprint;
}

function captureSource(target: ReturnType<typeof repository>, baseline: string, source: IntegrationSource) {
  const candidate = repository(source.path);
  if (candidate.root === target.root || candidate.common !== target.common) {
    throw new Error("Every integration source must be an isolated worktree of this project.");
  }
  if (!/^[a-f0-9]{40,64}$/i.test(source.base) || !source.submissionId) throw new Error("Invalid candidate baseline or submission.");
  git(candidate.root, ["merge-base", "--is-ancestor", source.base, "HEAD"]);
  git(target.root, ["merge-base", "--is-ancestor", source.base, baseline]);
  const captured = snapshot(candidate.root);
  if (!source.expectedFingerprint || source.expectedFingerprint !== captured.fingerprint) {
    throw new Error(`Candidate ${source.agentId} changed since acceptance. Revalidate it before integration.`);
  }
  return { source, path: candidate.root, ...captured };
}

/** Combine accepted submissions in a new detached worktree; never merge the project branch. */
export function integrateCandidates(project: string, candidates: IntegrationSource[]) {
  if (candidates.length < 2 || new Set(candidates.map((source) => source.agentId)).size !== candidates.length) {
    throw new Error("Choose at least two distinct accepted coder submissions to integrate.");
  }
  return materializeCandidates(project, candidates);
}

function materializeCandidates(project: string, candidates: IntegrationSource[], pinnedBaseline?: string) {
  const target = repository(project);
  const baseline = pinnedBaseline ?? git(target.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const snapshots = candidates.map((source) => captureSource(target, baseline, source));
  if (new Set(snapshots.map((source) => source.path)).size !== snapshots.length) {
    throw new Error("Each integrated coder must have a distinct isolated worktree.");
  }
  const integration = createFeatureWorktree(target.root, pinnedBaseline);
  const identity = {
    GIT_AUTHOR_NAME: "Orchestra", GIT_AUTHOR_EMAIL: "orchestra@localhost",
    GIT_COMMITTER_NAME: "Orchestra", GIT_COMMITTER_EMAIL: "orchestra@localhost",
  };
  try {
    if (integration.base !== baseline) throw new Error("The project baseline changed before integration began. Retry.");
    for (const source of snapshots) {
      const commit = git(source.path, ["commit-tree", source.tree, "-p", source.source.base,
        "-m", `Snapshot ${source.source.agentId} submission ${source.source.submissionId}`], identity);
      // A source with no changes adds no patch; do not create an empty cherry-pick.
      if (source.tree === git(source.path, ["rev-parse", `${source.source.base}^{tree}`])) continue;
      try {
        git(integration.path, ["-c", "rerere.enabled=false", "cherry-pick", commit], identity);
      } catch {
        throw new Error(`Integration conflict or failed Git application for ${source.source.agentId}. The source worktree is unchanged. Resolve the overlap in the coder assignments before retrying.`);
      }
    }
    for (const source of snapshots) {
      if (fingerprintCandidate(source.path) !== source.fingerprint) {
        throw new Error(`Candidate ${source.source.agentId} changed during integration. Revalidate it before retrying.`);
      }
    }
    return {
      ...integration,
      fingerprint: fingerprintCandidate(integration.path),
      sources: snapshots.map(({ source, head, fingerprint }) => ({ agentId: source.agentId, submissionId: source.submissionId, head, fingerprint })),
    };
  } catch (error) {
    removeFeatureWorktree(target.root, integration.path);
    throw error;
  }
}

export function fingerprintMemberSnapshots(members: readonly IntegrationMember[]) {
  const ordered = [...members].sort((a, b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0);
  const descriptors = ordered.map(({ projectId, path, base, fingerprint }) => [projectId, path, base, fingerprint]);
  return createHash("sha256").update(JSON.stringify(descriptors)).digest("hex");
}

/** Recompute the manifest fingerprint from current checked-out contents. */
export function fingerprintIntegrationMembers(members: readonly Omit<IntegrationMember, "fingerprint">[]) {
  return fingerprintMemberSnapshots(members.map((member) => ({ ...member, fingerprint: fingerprintCandidate(member.path) })));
}

/** Prepare independent candidates per repository and pin them as a single testable delivery. */
export function integrateProjectCandidates(
  projects: readonly { id: string; path: string }[],
  sources: ProjectSource[],
): ProjectIntegration {
  if (sources.length < 2 || new Set(sources.map((source) => source.agentId)).size !== sources.length) {
    throw new Error("Choose at least two distinct accepted coder submissions to integrate.");
  }
  return prepareProjectCandidates(projects, sources, false);
}

/** Copy one coder's pinned submission into clean delivery worktrees without rebasing it. */
export function pinDirectCandidates(projects: readonly { id: string; path: string }[], sources: ProjectSource[]) {
  if (sources.length < 2 || new Set(sources.map(({ projectId }) => projectId)).size !== sources.length) {
    throw new Error("Direct delivery needs one candidate per selected repository.");
  }
  return prepareProjectCandidates(projects, sources, true);
}

function prepareProjectCandidates(projects: readonly { id: string; path: string }[], sources: ProjectSource[],
  pinned: boolean): ProjectIntegration {
  const groups = new Map<string, ProjectSource[]>();
  for (const source of sources) {
    const group = groups.get(source.projectId) ?? [];
    group.push(source);
    groups.set(source.projectId, group);
  }
  const selected = projects.filter(({ id }) => groups.has(id));
  if (selected.length !== groups.size) throw new Error("Every integration source needs a configured project.");
  if (selected.length === 1) return integrateCandidates(selected[0].path, sources);

  const created: { project: string; path: string }[] = [];
  const members: IntegrationMember[] = [];
  const submissions: ProjectIntegration["sources"] = [];
  try {
    for (const { id: projectId, path: project } of selected) {
      const group = groups.get(projectId)!;
      const combined = materializeCandidates(project, group, pinned ? group[0].base : undefined);
      created.push({ project, path: combined.path });
      members.push({ projectId, path: combined.path, base: combined.base, fingerprint: combined.fingerprint,
        ...(pinned && { revision: git(combined.path, ["rev-parse", "--verify", "HEAD^{commit}"]) }) });
      submissions.push(...combined.sources.map((source) => ({ ...source, projectId })));
    }
    const fingerprint = fingerprintMemberSnapshots(members);
    if (fingerprintIntegrationMembers(members) !== fingerprint ||
        sources.some((source) => fingerprintCandidate(source.path) !== source.expectedFingerprint)) {
      throw new Error("An integration candidate changed during preparation. Revalidate it before retrying.");
    }
    const [{ path, base }] = members;
    return { path, base, fingerprint, members, sources: submissions };
  } catch (error) {
    for (const { project, path } of created.reverse()) removeFeatureWorktree(project, path);
    throw error;
  }
}
