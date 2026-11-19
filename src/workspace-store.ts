import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceAgent, WorkspaceProvider } from "./workspace-runtime.ts";

export type SavedSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  toolVersion?: number;
  waitingFor?: string;
  run?: { messageId: string; turnId?: string };
};

export function workspaceStore(project: string, directory?: string, provider: WorkspaceProvider = "codex") {
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const explicitDirectory = directory ?? process.env.ORCHESTRA_STATE_DIR ?? process.env.SWARMER_STATE_DIR;
  directory = explicitDirectory ?? join(stateRoot, "orchestra");
  const filename = createHash("sha256").update(project).digest("hex") + ".json";
  const path = join(directory, provider === "claude" ? `claude-${filename}` : filename);
  const legacyPath = explicitDirectory || provider !== "codex" ? undefined : join(stateRoot, "swarmer", filename);
  return {
    load(): SavedSession[] | undefined {
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
      return saved.sessions;
    },
    save(sessions: SavedSession[]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, project, sessions }), { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
