export type WorkspaceOptions = {
  live: boolean;
  projectPath?: string;
  provider: string;
  feature: boolean;
};

export function parseWorkspaceArgs(args: string[]): WorkspaceOptions {
  let live = false;
  let projectPath: string | undefined;
  let provider = "openai";
  let providerSpecified = false;
  let feature = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") {
      if (live) throw new Error("Specify --live only once.");
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
    } else if (arg === "--feature") {
      if (feature) throw new Error("Specify --feature only once.");
      feature = true;
    } else if (!arg.startsWith("--") && live && !projectPath) {
      projectPath = arg;
    } else {
      throw new Error(`Unknown workspace option: ${arg}`);
    }
  }

  if ((!live && (projectPath || providerSpecified || feature)) || (!live && args.length)) {
    throw new Error("Usage: npm run workspace -- [--live [project-path]] [--provider provider-id]");
  }
  return { live, projectPath, provider, feature };
}
