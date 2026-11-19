import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

export type WorkspaceProject = { id: string; path: string };

export function resolveProjects(projects: WorkspaceProject[]): WorkspaceProject[] {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const resolved = projects.map(({ id, path }) => ({
    id,
    path: realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(path), env, encoding: "utf8",
    }).trim()),
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(resolved.map((project) => project.id)).size !== resolved.length) throw new Error("Project IDs must be unique.");
  if (new Set(resolved.map((project) => project.path)).size !== resolved.length) throw new Error("Each project must be a different Git repository.");
  return resolved;
}

export function defaultProject(path: string): WorkspaceProject {
  return { id: basename(resolve(path)), path };
}

export function workspaceIdentity(projects: WorkspaceProject[]): string {
  if (projects.length === 1) return projects[0].path;
  return `multi-repository:${JSON.stringify([...projects].sort((a, b) => a.id.localeCompare(b.id)))}`;
}
