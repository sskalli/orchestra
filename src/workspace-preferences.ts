import { readFlightLog } from "./workspace-flight-log.ts";
import type { FlightLog } from "./workspace-flight-log.ts";

export type Camera = { x: number; y: number; scale: number };
export type PanelSizes = { left?: number; right?: number; leftHeight?: number; mobileLeft?: number; mobileLeftWidth?: number };
export type ComposerSizes = { agent?: number };

type View = { leftOpen: boolean; selectedId: string | null; drafts: Record<string, string> };

export function workspacePreferences(projectPath: string, mode: "demo" | "codex", modelProvider = "openai") {
  const customProvider = mode === "codex" && modelProvider !== "openai";
  const key = customProvider
    ? `orchestra:workspace:v1:codex-provider:${modelProvider}:${projectPath}`
    : `orchestra:workspace:v1:${mode}:${projectPath}`;

  function read(name: string): unknown {
    try {
      const value = localStorage.getItem(`${key}:${name}`);
      return JSON.parse(value ?? "null");
    } catch {
      return null;
    }
  }

  function write(name: string, value: unknown) {
    try {
      localStorage.setItem(`${key}:${name}`, JSON.stringify(value));
      return true;
    } catch {
      window.dispatchEvent(new Event("orchestra-storage-unavailable"));
      return false;
    }
  }

  let unsavedFlightLog: FlightLog | undefined;
  const readLatestFlightLog = () => unsavedFlightLog ?? readFlightLog(read("flight-log"));

  return {
    readView(): View {
      const value = read("view") as Partial<View> | null;
      const drafts = value?.drafts;
      return {
        leftOpen: value?.leftOpen === true,
        selectedId: typeof value?.selectedId === "string" ? value.selectedId : null,
        drafts: drafts && typeof drafts === "object" && !Array.isArray(drafts)
          ? Object.fromEntries(Object.entries(drafts).filter(([, draft]) => typeof draft === "string"))
          : {},
      };
    },
    writeView: (view: View) => write("view", view),
    readInboxReadSequence(): number {
      const value = read("inbox-read-sequence");
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    },
    writeInboxReadSequence: (sequence: number) => write("inbox-read-sequence", sequence),
    readFlightLog: readLatestFlightLog,
    async updateFlightLog(update: (log: FlightLog) => FlightLog) {
      function commit() {
        const current = readLatestFlightLog();
        const next = update(current);
        if (next !== current) unsavedFlightLog = write("flight-log", next) ? undefined : next;
        return next;
      }
      return navigator.locks ? navigator.locks.request(`${key}:flight-log`, commit) : commit();
    },
    subscribeFlightLog(listener: (log: FlightLog) => void) {
      const onStorage = (event: StorageEvent) => {
        if (event.key === `${key}:flight-log` || event.key === null) listener(readLatestFlightLog());
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
    readPanels(): PanelSizes {
      const value = read("panels") as PanelSizes | null;
      const size = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? entry : undefined;
      return {
        left: size(value?.left), right: size(value?.right),
        leftHeight: size(value?.leftHeight), mobileLeft: size(value?.mobileLeft),
        mobileLeftWidth: size(value?.mobileLeftWidth),
      };
    },
    writePanels: (panels: PanelSizes) => write("panels", panels),
    readComposers(): ComposerSizes {
      const value = read("composers") as ComposerSizes | null;
      const size = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? entry : undefined;
      return { agent: size(value?.agent) };
    },
    writeComposers: (sizes: ComposerSizes) => write("composers", sizes),
    readCamera(): Camera | undefined {
      const value = read("camera") as Camera | null;
      if (value && Number.isFinite(value.x) && Number.isFinite(value.y) &&
          Number.isFinite(value.scale) && value.scale >= 0.3 && value.scale <= 2.5) return value;
    },
    writeCamera: (camera: Camera) => write("camera", camera),
  };
}
