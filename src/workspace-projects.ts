import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

export type WorkspaceProject = { id: string; path: string };

export function resolveProjects(projects: WorkspaceProject[]): WorkspaceProject[] {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  if (new Set(projects.map((project) => project.id)).size !== projects.length) throw new Error("Project IDs must be unique.");
  const repositories = new Map<string, string>();
  const gitPath = (cwd: string, arg: string) => realpathSync(resolve(cwd, execFileSync("git", ["rev-parse", arg], {
    cwd, env, encoding: "utf8",
  }).trim()));
  return projects.map(({ id, path }) => {
    const checkout = gitPath(resolve(path), "--show-toplevel");
    const repository = gitPath(checkout, "--git-common-dir");
    const existingId = repositories.get(repository);
    if (existingId !== undefined) {
      throw new Error(`Each project must be a different Git repository. Projects '${existingId}' and '${id}' share one.`);
    }
    repositories.set(repository, id);
    return { id, path: checkout };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function defaultProject(path: string): WorkspaceProject {
  return { id: basename(resolve(path)), path };
}

export function workspaceIdentity(projects: WorkspaceProject[]): string {
  if (projects.length === 1) return projects[0].path;
  return `multi-repository:${JSON.stringify([...projects].sort((a, b) => a.id.localeCompare(b.id)))}`;
}
