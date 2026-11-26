import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Where a task's edits live: an isolated worktree, or a configured checkout edited in place. */
export type DiffSource = { projectId: string; mode: "automatic" | "worktree" | "checkout"; path: string; base: string };
export type DiffLineKind = "+" | "-" | " " | "@" | "\\";
/** One rendered diff line: kind, text, then old and new line numbers where they apply. */
export type DiffLine = [kind: DiffLineKind, text: string, oldLine?: number | null, newLine?: number | null];
export type DiffFileStatus = "A" | "M" | "D" | "R" | "C" | "T";
export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  lines: DiffLine[];
  /** The patch for this file had more lines than were sent. */
  truncated?: boolean;
  /** The patch for this file was not loaded because the repository's diff exceeded the size limit. */
  omitted?: boolean;
};
export type DiffGroup = {
  projectId: string;
  mode: DiffSource["mode"];
  base: string;
  files: DiffFile[];
  /** More files changed than were listed. */
  moreFiles?: number;
  error?: string;
};
export type TaskDiff = { kind: "general" } | { kind: "repositories"; groups: DiffGroup[] };

export const diffLimits = {
  /** Patch bytes read per repository before the remaining files are reported as omitted. */
  patchBytes: 4 * 1024 * 1024,
  /** Diff lines sent per file. */
  fileLines: 2000,
  /** Diff lines sent per repository. */
  totalLines: 12000,
  /** Characters shown per line. */
  lineLength: 2000,
  files: 2000,
  timeoutMs: 30_000,
};

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

function cleanEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...overrides };
}

// Never run repository hooks, fsmonitor programs, external diff drivers or pagers.
const safeConfig = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off",
  "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "color.ui=false",
  "--no-pager",
];

type GitResult = { stdout: Buffer; truncated: boolean };

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, limit = 64 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...safeConfig, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, diffLimits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = limit - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = limit;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Git took too long to compute the changes."));
      else if (truncated || code === 0) resolvePromise({ stdout: Buffer.concat(chunks), truncated });
      else reject(new Error(stderr.trim().split("\n").at(-1) || `Git exited with status ${code}.`));
    });
  });
}

const statusLetters = new Set(["A", "M", "D", "R", "C", "T"]);

/** Parse `git diff --name-status -z -M` output. */
export function parseNameStatus(output: string) {
  const fields = output.split("\0");
  const entries: { status: DiffFileStatus; path: string; oldPath?: string }[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    const letter = code[0];
    const status = (statusLetters.has(letter) ? letter : "M") as DiffFileStatus;
    if (letter === "R" || letter === "C") {
      const oldPath = fields[index++];
      entries.push({ status, oldPath, path: fields[index++] });
    } else entries.push({ status, path: fields[index++] });
  }
  return entries;
}

/** Parse `git diff --numstat -z -M` output; binary files report "-" counts. */
export function parseNumstat(output: string) {
  const fields = output.split("\0");
  const entries: { additions: number; deletions: number; binary: boolean; path: string; oldPath?: string }[] = [];
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record) continue;
    const [added, deleted, ...rest] = record.split("\t");
    const path = rest.join("\t");
    const binary = added === "-" && deleted === "-";
    const counts = { additions: binary ? 0 : Number(added) || 0, deletions: binary ? 0 : Number(deleted) || 0, binary };
    if (path === "") {
      const oldPath = fields[index++];
      entries.push({ ...counts, oldPath, path: fields[index++] });
    } else entries.push({ ...counts, path });
  }
  return entries;
}

export type ParsedPatch = { lines: DiffLine[]; binary: boolean; truncated: boolean };

/**
 * Split a unified patch into per-file line lists, in Git's output order.
 * When the stream was cut at the byte limit, the last section is marked truncated.
 */
export function parsePatch(patch: string, streamTruncated = false, limits = diffLimits): ParsedPatch[] {
  const sections: ParsedPatch[] = [];
  let current: ParsedPatch | undefined;
  let inHunk = false;
  let total = 0;
  let oldLine = 0;
  let newLine = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      current = { lines: [], binary: false, truncated: false };
      sections.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (!hunk && !inHunk) {
      if (/^Binary files .* differ$/.test(row) || row === "GIT binary patch") current.binary = true;
      continue;
    }
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    }
    if (current.truncated) continue;
    if (current.lines.length >= limits.fileLines || total >= limits.totalLines) {
      current.truncated = true;
      continue;
    }
    const kind = row[0];
    const text = row.length > limits.lineLength ? row.slice(1, limits.lineLength) + "…" : row.slice(1);
    if (hunk) current.lines.push(["@", row.length > limits.lineLength ? row.slice(0, limits.lineLength) + "…" : row]);
    else if (kind === "+") current.lines.push(["+", text, null, newLine++]);
    else if (kind === "-") current.lines.push(["-", text, oldLine++]);
    else if (kind === " ") current.lines.push([" ", text, oldLine++, newLine++]);
    else if (kind === "\\") current.lines.push(["\\", text]);
    else continue;
    total++;
  }
  if (streamTruncated && current) current.truncated = true;
  return sections;
}

/** Diff the current contents of one worktree, including untracked files Git does not ignore, against its base commit. */
export async function diffSource(source: DiffSource): Promise<DiffGroup> {
  const group: DiffGroup = { projectId: source.projectId, mode: source.mode, base: source.base, files: [] };
  if (!shaPattern.test(source.base)) return { ...group, error: "The task's base revision is invalid." };
  let temporary: string | undefined;
  try {
    let root: string;
    try {
      root = await realpath(source.path);
    } catch {
      throw new Error(source.mode === "checkout" ? "The configured checkout is unavailable." : "The task's worktree no longer exists.");
    }
    const plain = cleanEnvironment();
    const text = async (args: string[], env = plain) => (await runGit(root, args, env)).stdout.toString("utf8");
    const top = (await text(["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(top) !== root) throw new Error("The task's worktree is not a complete Git worktree.");
    try {
      await text(["cat-file", "-e", source.base + "^{commit}"]);
    } catch {
      throw new Error("The task's base revision is no longer available in this repository.");
    }

    // Stage everything into a throwaway index and object directory so the real index and object store stay untouched.
    temporary = await mkdtemp(join(tmpdir(), "orchestra-diff-"));
    const objects = resolve(root, (await text(["rev-parse", "--git-path", "objects"])).trim());
    const temporaryObjects = join(temporary, "objects");
    await mkdir(join(temporaryObjects, "info"), { recursive: true });
    await writeFile(join(temporaryObjects, "info", "alternates"), objects + "\n");
    const env = cleanEnvironment({ GIT_INDEX_FILE: join(temporary, "index"), GIT_OBJECT_DIRECTORY: temporaryObjects });
    const index = resolve(root, (await text(["rev-parse", "--git-path", "index"])).trim());
    try {
      // Starting from the real index keeps Git's stat cache, so unchanged files are not hashed again.
      await copyFile(index, join(temporary, "index"));
      await text(["add", "-A", "--", "."], env);
    } catch {
      await rm(join(temporary, "index"), { force: true });
      await text(["read-tree", "HEAD"], env);
      await text(["add", "-A", "--", "."], env);
    }

    const common = ["diff", "--cached", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
    const names = parseNameStatus(await text([...common, "--name-status", "-z", source.base, "--"], env));
    if (!names.length) return group;
    const counts = parseNumstat(await text([...common, "--numstat", "-z", source.base, "--"], env));
    const patch = await runGit(root, [...common, "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", source.base, "--"],
      env, diffLimits.patchBytes);
    const sections = parsePatch(patch.stdout.toString("utf8"), patch.truncated);
    // Git emits name-status, numstat and patch sections in the same order for the same diff options.
    group.files = names.slice(0, diffLimits.files).map((entry, position) => {
      const count = counts[position]?.path === entry.path ? counts[position] : counts.find(({ path }) => path === entry.path);
      const section = sections[position];
      const binary = Boolean(count?.binary || section?.binary);
      const file: DiffFile = {
        path: entry.path, status: entry.status,
        additions: count?.additions ?? 0, deletions: count?.deletions ?? 0,
        binary, lines: binary || !section ? [] : section.lines,
      };
      if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
      if (section?.truncated && !binary) file.truncated = true;
      if (!section && !binary) file.omitted = true;
      return file;
    });
    if (names.length > group.files.length) group.moreFiles = names.length - group.files.length;
    return group;
  } catch (error) {
    return { ...group, error: error instanceof Error ? error.message : "Orchestra could not compute the changes." };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export async function taskDiff(sources: DiffSource[] | "general"): Promise<TaskDiff> {
  if (sources === "general") return { kind: "general" };
  const groups: DiffGroup[] = [];
  for (const source of sources) groups.push(await diffSource(source));
  return { kind: "repositories", groups };
}
