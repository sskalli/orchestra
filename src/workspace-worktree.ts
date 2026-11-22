import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function createFeatureWorktree(project: string, revision = "HEAD") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: project, env, encoding: "utf8",
  }).trim();
  const base = git("rev-parse", "--verify", revision + "^{commit}");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-feature-")));
  const path = join(directory, "candidate");
  try {
    git("worktree", "add", "--detach", path, base);
  } catch (error) {
    try { rmdirSync(directory); } catch { /* Keep partial Git state available for inspection. */ }
    throw error;
  }
  return { path, base };
}

/** Remove an isolated worktree created by the current attempt. */
export function removeFeatureWorktree(project: string, path: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", path],
      { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    rmdirSync(dirname(path));
  } catch { /* Preserve partial state if Git cannot remove it. */ }
}
