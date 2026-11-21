import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileUpdate } from "./app-server.ts";

function worktreeFile(root: string, path: unknown) {
  if (typeof path !== "string" || !path || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").includes("..")) return;
  const name = relative(root, resolve(root, path));
  if (!name || isAbsolute(name) || name === ".." || name.startsWith(".." + sep)) return;
  const parts = name.split(sep);
  if (parts.some((part) => part.toLowerCase() === ".git")) return;
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      break;
    }
  }
  return name;
}

export function describeWorktreePatch(root: string, changes: FileUpdate[]) {
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || !Array.isArray(changes) || !changes.length) return;
  } catch {
    return;
  }
  const preview: string[] = [];
  let length = 0;
  for (const change of changes) {
    const path = worktreeFile(root, change?.path);
    const kind = change?.kind?.type;
    if (!path || typeof change.diff !== "string" || (kind !== "add" && kind !== "delete" && kind !== "update")) return;
    let target = "";
    if (change.kind.type === "update" && change.kind.move_path !== null) {
      const move = worktreeFile(root, change.kind.move_path);
      if (!move) return;
      target = ` → ${JSON.stringify(move)}`;
    }
    const entry = `${kind.toUpperCase()} ${JSON.stringify(path)}${target}\n${change.diff}`;
    length += entry.length;
    if (length > 64_000) return;
    preview.push(entry);
  }
  return preview.join("\n\n");
}

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
