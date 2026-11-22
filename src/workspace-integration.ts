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

function isolatedRepository(target: ReturnType<typeof repository>, path: string) {
  const candidate = repository(path);
  if (candidate.root === target.root || candidate.common !== target.common) {
    throw new Error("Every integration source must be an isolated worktree of this project.");
  }
  return candidate;
}

export function validateCandidateWorktree(project: string, candidate: { path: string; base: string }) {
  const root = isolatedRepository(repository(project), candidate.path).root;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(candidate.base)) throw new Error("Invalid candidate baseline.");
  git(root, ["merge-base", "--is-ancestor", candidate.base, "HEAD"]);
}

function captureSource(target: ReturnType<typeof repository>, baseline: string, source: IntegrationSource) {
  const candidate = isolatedRepository(target, source.path);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(source.base) || !source.submissionId) throw new Error("Invalid candidate baseline or submission.");
  git(candidate.root, ["merge-base", "--is-ancestor", source.base, "HEAD"]);
  git(target.root, ["merge-base", "--is-ancestor", source.base, baseline]);
  const captured = snapshot(candidate.root);
  if (!source.expectedFingerprint || source.expectedFingerprint !== captured.fingerprint) {
    throw new Error(`Candidate ${source.agentId} changed since acceptance. Revalidate it before integration.`);
  }
  return { source, path: candidate.root, ...captured };
}

function materializeCandidate(project: string, candidate: IntegrationSource) {
  const target = repository(project);
  const baseline = candidate.base;
  const source = captureSource(target, baseline, candidate);
  const integration = createFeatureWorktree(target.root, baseline);
  const identity = {
    GIT_AUTHOR_NAME: "Orchestra", GIT_AUTHOR_EMAIL: "orchestra@localhost",
    GIT_COMMITTER_NAME: "Orchestra", GIT_COMMITTER_EMAIL: "orchestra@localhost",
  };
  try {
    if (integration.base !== baseline) throw new Error("The project baseline changed before integration began. Retry.");
    if (source.tree !== git(source.path, ["rev-parse", `${baseline}^{tree}`])) {
      const commit = git(source.path, ["commit-tree", source.tree, "-p", baseline,
        "-m", `Snapshot ${candidate.agentId} submission ${candidate.submissionId}`], identity);
      git(integration.path, ["-c", "rerere.enabled=false", "cherry-pick", commit], identity);
    }
    if (fingerprintCandidate(source.path) !== source.fingerprint) {
      throw new Error("The candidate changed during preparation. Revalidate it before retrying.");
    }
    return {
      ...integration,
      fingerprint: fingerprintCandidate(integration.path),
      source: { agentId: candidate.agentId, submissionId: candidate.submissionId, head: source.head, fingerprint: source.fingerprint },
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

/** Deliver a changed single-repository submission at its original baseline. */
export function pinApprovedCandidate(project: string, source: IntegrationSource) {
  const delivery = materializeCandidate(project, source);
  try {
    const revision = git(delivery.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (revision === delivery.base) throw new Error("The coder finished without changes to the approved repository.");
    return { path: delivery.path, revision };
  } catch (error) {
    removeFeatureWorktree(project, delivery.path);
    throw error;
  }
}

/** Copy one coder's pinned submission into clean delivery worktrees without rebasing it. */
export function pinDirectCandidates(projects: readonly { id: string; path: string }[], sources: ProjectSource[]): ProjectIntegration {
  if (sources.length < 2 || new Set(sources.map(({ projectId }) => projectId)).size !== sources.length) {
    throw new Error("Direct delivery needs one candidate per selected repository.");
  }
  const byProject = new Map(sources.map((source) => [source.projectId, source]));
  const selected = projects.filter(({ id }) => byProject.has(id));
  if (selected.length !== sources.length) throw new Error("Every integration source needs a configured project.");

  const created: { project: string; path: string }[] = [];
  const members: IntegrationMember[] = [];
  const submissions: ProjectIntegration["sources"] = [];
  try {
    for (const { id: projectId, path: project } of selected) {
      const combined = materializeCandidate(project, byProject.get(projectId)!);
      created.push({ project, path: combined.path });
      members.push({ projectId, path: combined.path, base: combined.base, fingerprint: combined.fingerprint,
        revision: git(combined.path, ["rev-parse", "--verify", "HEAD^{commit}"]) });
      submissions.push({ ...combined.source, projectId });
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
