import { validateCandidateWorktree } from "./workspace-integration.ts";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type WriteTarget =
  | { projectId: string; mode: "checkout" }
  | { projectId: string; mode: "worktree"; path: string; branch?: string };

function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isWithin(root: string, path: string) {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(".." + sep) && !isAbsolute(offset));
}

function overlaps(left: string, right: string) {
  return isWithin(left, right) || isWithin(right, left);
}

function worktreePath(input: string) {
  if (!isAbsolute(input) || input.length > 4096 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error("Choose an absolute worktree path.");
  }
  const path = resolve(input);
  if (!basename(path)) throw new Error("Choose a directory for the worktree.");
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    throw new Error("Choose a worktree path whose parent directory already exists.");
  }
}

export function resolveWriteTargets(
  raw: unknown, projects: readonly { id: string; path: string }[], selectedIds: readonly string[],
): WriteTarget[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > selectedIds.length) {
    throw new Error("Choose at most one write target per selected repository.");
  }
  const occupied = new Set<string>();
  const destinations: string[] = [];
  let protectedPaths: string[] | undefined;
  return raw.map((target: Record<string, unknown> | null) => {
    if (!target || typeof target !== "object" || typeof target.projectId !== "string" ||
        !selectedIds.includes(target.projectId) || occupied.has(target.projectId)) {
      throw new Error("Each write target must identify a distinct selected repository.");
    }
    const project = projects.find(({ id }) => id === target.projectId);
    if (!project) throw new Error("The requested repository is unavailable.");
    occupied.add(project.id);
    if (target.mode === "checkout" && target.path === undefined && target.branch === undefined) {
      if (projects.some((other) => other.id !== project.id && isWithin(project.path, other.path))) {
        throw new Error("The configured checkout contains another project. Use an isolated worktree.");
      }
      return { projectId: project.id, mode: "checkout" };
    }
    if (target.mode !== "worktree" || typeof target.path !== "string") {
      throw new Error("Choose a configured checkout or a new linked worktree.");
    }
    const path = worktreePath(target.path);
    protectedPaths ??= projects.flatMap(({ path: root }) => [
      root, realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    ]);
    if (path.split(sep).some((part) => part.toLowerCase() === ".git") ||
        protectedPaths.some((root) => overlaps(root, path)) || destinations.some((other) => overlaps(other, path))) {
      throw new Error("Choose a separate worktree path outside configured repositories and their Git metadata.");
    }
    destinations.push(path);
    if (target.branch === undefined) return { projectId: project.id, mode: "worktree", path };
    if (typeof target.branch !== "string" || target.branch.length > 240 ||
        target.branch.startsWith("-") || /[\u0000-\u001f\u007f]/.test(target.branch)) {
      throw new Error("Choose a valid name for the new worktree branch.");
    }
    try {
      git(project.path, "check-ref-format", "refs/heads/" + target.branch);
    } catch {
      throw new Error("Choose a valid name for the new worktree branch.");
    }
    return { projectId: project.id, mode: "worktree", path, branch: target.branch };
  });
}

export function createRequestedWorktree(project: string, target: Extract<WriteTarget, { mode: "worktree" }>) {
  const { path, branch } = target;
  if (worktreePath(path) !== path) throw new Error("The approved worktree location changed. Request approval again.");
  try {
    lstatSync(path);
    throw new Error("The requested worktree location already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const base = git(project, "rev-parse", "--verify", "HEAD^{commit}");
  git(project, "worktree", "add", ...(branch ? ["-b", branch] : ["--detach"]), "--", path, base);
  return { path, base };
}

export function removeRequestedWorktree(project: string, path: string, branch?: string, base?: string) {
  try {
    git(project, "worktree", "remove", "--", path);
    if (branch && base) git(project, "update-ref", "-d", "refs/heads/" + branch, base);
  } catch { /* Preserve partial state for inspection if Git cannot roll back. */ }
}

export function checkoutBaseline(project: string) {
  if (realpathSync(project) !== project || realpathSync(git(project, "rev-parse", "--show-toplevel")) !== project) {
    throw new Error("The configured checkout changed. Restart Orchestra with the intended checkout.");
  }
  return git(project, "rev-parse", "--verify", "HEAD^{commit}");
}

export function validateRequestedWorktree(
  project: string, target: Extract<WriteTarget, { mode: "worktree" }>, candidate: { path: string; base: string },
) {
  if (target.path !== candidate.path || realpathSync(candidate.path) !== candidate.path) {
    throw new Error("The requested worktree location changed.");
  }
  validateCandidateWorktree(project, candidate);
  let branch: string | undefined;
  try {
    branch = git(candidate.path, "symbolic-ref", "--quiet", "HEAD");
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  if (branch !== (target.branch ? "refs/heads/" + target.branch : undefined)) {
    throw new Error("The requested worktree branch changed.");
  }
}
