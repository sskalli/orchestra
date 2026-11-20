import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceAgent } from "./workspace-runtime.ts";
import { isWorkspaceTeam, type WorkspaceTeam } from "./workspace-teams.ts";

export type SavedSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  toolVersion?: number;
  waitingFor?: string;
  run?: { messageId: string; turnId?: string };
};

type SavedWorkspace = { sessions: SavedSession[]; teams: WorkspaceTeam[] };

export function workspaceStore(project: string, directory?: string, provider = "codex", modelProvider?: string) {
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const explicitDirectory = directory ?? process.env.ORCHESTRA_STATE_DIR ?? process.env.SWARMER_STATE_DIR;
  directory = explicitDirectory ?? join(stateRoot, "orchestra");
  const claude = provider === "claude";
  const codexProvider = modelProvider ?? (provider === "codex" || claude ? "openai" : provider);
  const filename = createHash("sha256")
    .update(project)
    .update(codexProvider === "openai" ? "" : `\0${codexProvider}`)
    .digest("hex") + ".json";
  const path = join(directory, claude ? `claude-${filename}` : filename);
  const legacyPath = explicitDirectory || claude ? undefined : join(stateRoot, "swarmer", filename);
  function loadWorkspace(): SavedWorkspace | undefined {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!legacyPath) return undefined;
      try {
        contents = readFileSync(legacyPath, "utf8");
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw legacyError;
      }
    }
    const saved = JSON.parse(contents);
    if (saved?.version !== 1 || saved.project !== project || !Array.isArray(saved.sessions) ||
        !saved.sessions.some((session: SavedSession) => session?.agent?.id === "coordinator" && session.agent.role === "coordinator") ||
        saved.sessions.some((session: SavedSession) => typeof session?.agent?.id !== "string" ||
          typeof session.agent.name !== "string" || !Array.isArray(session.agent.messages))) {
      throw new Error("Orchestra could not read the saved workspace format.");
    }
    const teams = saved.teams === undefined ? [] : saved.teams;
    if (!Array.isArray(teams) || !teams.every(isWorkspaceTeam) ||
        new Set(teams.map(({ id }) => id)).size !== teams.length) {
      throw new Error("Orchestra could not read the saved team records.");
    }
    return { sessions: saved.sessions, teams };
  }

  return {
    usagePath: path.replace(/\.json$/, ".usage.json"),
    loadWorkspace,
    load: () => loadWorkspace()?.sessions,
    save(sessions: SavedSession[], teams = loadWorkspace()?.teams ?? []) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, project, sessions, teams }), { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
