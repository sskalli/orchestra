import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquirePathReservations, reservationOwnerAlive, releasePathReservations,
  type CheckoutReservation } from "./workspace-reservations.ts";
import type { WorkspaceAgent } from "./workspace-runtime.ts";

export type SavedSession = {
  agent: WorkspaceAgent;
  threadId?: string;
  toolVersion?: number;
  checkoutReservation?: CheckoutReservation;
  run?: { messageId: string; turnId?: string };
};

function readSessions(path: string, project: string): SavedSession[] | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const saved = JSON.parse(contents);
  if (saved?.version !== 1 || saved.project !== project || !Array.isArray(saved.sessions) ||
      saved.sessions.some((session: SavedSession) => typeof session?.agent?.id !== "string" ||
        typeof session.agent.name !== "string" || !Array.isArray(session.agent.messages))) {
    throw new Error("Orchestra could not read the saved workspace format.");
  }
  return saved.sessions;
}

function directSessions(sessions: SavedSession[]) {
  const ids = new Set(sessions.filter(({ agent }) => agent.directTask).map(({ agent }) => agent.id));
  let previous = 0;
  while (ids.size !== previous) {
    previous = ids.size;
    for (const { agent } of sessions) {
      if (agent.nativeChild && agent.parentId && ids.has(agent.parentId)) ids.add(agent.id);
    }
  }
  return sessions.filter(({ agent }) => ids.has(agent.id));
}

export function workspaceStore(project: string, directory?: string, modelProvider = "openai") {
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  directory ??= process.env.ORCHESTRA_STATE_DIR || join(stateRoot, "orchestra");
  const filename = createHash("sha256")
    .update(project)
    .update(modelProvider === "openai" ? "" : `\0${modelProvider}`)
    .digest("hex");
  const path = join(directory, filename + ".tasks.json");
  const previousPath = join(directory, filename + ".json");

  return {
    usagePath: path.replace(/\.json$/, ".usage.json"),
    previousUsagePath: previousPath.replace(/\.json$/, ".usage.json"),
    reserveProcess() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const lock = path + ".lock";
      let markers: string[];
      try {
        markers = readdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        markers = [];
      }
      if (markers.length === 1) {
        const id = markers[0];
        const pid = Number(/^(\d+)-[a-f0-9-]{36}$/.exec(id)?.[1]);
        if (Number.isSafeInteger(pid) && pid > 0 && !reservationOwnerAlive({ pid })) {
          releasePathReservations({ id, directories: [lock] });
        }
      }
      const reservation = { id: process.pid + "-" + randomUUID(), directories: [lock] };
      try {
        acquirePathReservations(reservation);
      } catch (error) {
        throw new Error("Could not reserve workspace state. Check whether another server is running for this workspace.", { cause: error });
      }
      return () => releasePathReservations(reservation);
    },
    load() {
      const sessions = readSessions(path, project);
      if (sessions) return sessions;
      const previous = readSessions(previousPath, project);
      return previous && directSessions(previous);
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
