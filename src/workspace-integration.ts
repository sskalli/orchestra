import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createFeatureWorktree } from "./workspace-worktree.ts";

export type IntegrationSource = { agentId: string; path: string; base: string; submissionId: string; expectedFingerprint: string };

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

/** Combine accepted submissions in a new detached worktree; never merge the project branch. */
export function integrateCandidates(project: string, candidates: IntegrationSource[]) {
  if (candidates.length < 2 || new Set(candidates.map((source) => source.agentId)).size !== candidates.length) {
    throw new Error("Choose at least two distinct accepted coder submissions to integrate.");
  }
  const target = repository(project);
  const baseline = git(target.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const snapshots = candidates.map((source) => {
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
  });
  if (new Set(snapshots.map((source) => source.path)).size !== snapshots.length) {
    throw new Error("Each integrated coder must have a distinct isolated worktree.");
  }
  const integration = createFeatureWorktree(target.root);
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
    // Only remove the worktree created by this call. Keep any cleanup failure
    // available for inspection instead of recursively deleting an arbitrary path.
    try { git(target.root, ["worktree", "remove", "--force", integration.path]); rmdirSync(dirname(integration.path)); } catch { /* Preserve partial state if Git cannot remove it. */ }
    throw error;
  }
}
