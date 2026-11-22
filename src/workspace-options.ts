export type WorkspaceOptions = {
  live: boolean;
  projectPath?: string;
  projects: { id: string; path: string }[];
  provider: string;
};

export function parseWorkspaceArgs(args: string[]): WorkspaceOptions {
  let live = false;
  let projectPath: string | undefined;
  const projects: WorkspaceOptions["projects"] = [];
  let provider = "openai";
  let providerSpecified = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") {
      if (live) throw new Error("Specify only one workspace mode.");
      live = true;
      if (args[index + 1] && !args[index + 1].startsWith("--")) projectPath = args[++index];
    } else if (arg === "--provider") {
      if (providerSpecified) throw new Error("Specify --provider only once.");
      const value = args[++index];
      if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
        throw new Error("--provider requires a Codex provider ID.");
      }
      provider = value;
      providerSpecified = true;
    } else if (arg === "--project") {
      const value = args[++index];
      const separator = value?.indexOf("=") ?? -1;
      const id = value?.slice(0, separator);
      const path = value?.slice(separator + 1);
      if (separator <= 0 || !id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || !path) {
        throw new Error("--project requires an ID and path in the form ID=/path/to/repository.");
      }
      if (projects.some((project) => project.id === id)) throw new Error(`Duplicate project ID: ${id}`);
      projects.push({ id, path });
    } else if (!arg.startsWith("--") && live && !projectPath) {
      projectPath = arg;
    } else {
      throw new Error(`Unknown workspace option: ${arg}`);
    }
  }

  if (projects.length && projectPath) throw new Error("Use either --live with a project path or --project, not both.");
  if (projects.length) live = true;
  if (!live && args.length) {
    throw new Error("Usage: npm run workspace -- [--live [project-path] | --project ID=path ...] [--provider provider-id]");
  }
  return { live, projectPath, projects, provider };
}
