import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Where a task's edits live: an isolated worktree, or a configured checkout edited in place. */
export type DiffSource = { projectId: string; mode: "automatic" | "worktree" | "checkout"; path: string; base: string; branch?: string };
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
  /** An untracked file that was not read: it is too large, or there are too many untracked files. */
  skipped?: "size" | "count";
};
export type DiffGroup = {
  projectId: string;
  mode: DiffSource["mode"];
  /** Where the changes are, to tell several worktrees of one repository apart. */
  path?: string;
  branch?: string;
  base: string;
  files: DiffFile[];
  /** More files changed than were listed. */
  moreFiles?: number;
  /** Limits that hid part of the changes. */
  notices?: string[];
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
  /** Untracked files read per repository, the largest one read, and their combined size. */
  untrackedFiles: 1000,
  untrackedFileBytes: 2 * 1024 * 1024,
  untrackedBytes: 32 * 1024 * 1024,
  /** One deadline for a whole request, across repositories. */
  timeoutMs: 30_000,
};

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

function cleanEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C",
    ...overrides,
  };
}

// Never run repository hooks, fsmonitor programs, external diff drivers, pagers or network fetches,
// and never write split-index or untracked-cache files into the repository.
const safeConfig = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off",
  "-c", "core.splitIndex=false", "-c", "core.untrackedCache=false", "-c", "protocol.allow=never",
  "-c", "core.attributesFile=/dev/null",
  "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.suppressBlankEmpty=false", "-c", "color.ui=false",
  "--no-pager",
];

type GitResult = { stdout: Buffer; truncated: boolean };
type GitOptions = { limit?: number; allowTruncation?: boolean; deadline: number; isolation?: string[] };

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, options: GitOptions): Promise<GitResult> {
  const { limit = 64 * 1024 * 1024, allowTruncation = false, deadline, isolation = [] } = options;
  return new Promise((resolvePromise, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error("Git took too long to compute the changes."));
      return;
    }
    const child = spawn("git", [...safeConfig, ...isolation, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, remaining);
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
      else if (truncated && !allowTruncation) reject(new Error("Git produced more output than Orchestra can show."));
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

let attrSourceSupport: Promise<boolean> | undefined;

/**
 * Config that keeps Git from running repository programs while it hashes files: every configured
 * clean/smudge/process filter is blanked, and attributes are read from an empty tree where Git supports it.
 */
async function isolationConfig(root: string, deadline: number) {
  const env = cleanEnvironment();
  let names: string[] = [];
  try {
    const output = (await runGit(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."], env, { deadline })).stdout;
    names = output.toString("utf8").split("\0").filter(Boolean);
  } catch (error) {
    // `git config --get-regexp` exits with status 1 when nothing matches.
    if (!/status 1\b/.test(String((error as Error).message))) throw error;
  }
  const drivers = [...new Set(names.map((name) => name.slice("filter.".length, name.lastIndexOf("."))))];
  if (drivers.some((name) => !name || /[=\n]/.test(name))) throw new Error("A Git filter in this repository cannot be disabled safely.");
  const config = drivers.flatMap((name) => ["clean", "smudge", "process"].map((key) => ["-c", `filter.${name}.${key}=`])
    .flat().concat(["-c", `filter.${name}.required=false`]));
  const emptyTree = (await runGit(root, ["hash-object", "-t", "tree", "/dev/null"], env, { deadline })).stdout.toString("utf8").trim();
  attrSourceSupport ??= runGit(root, [`--attr-source=${emptyTree}`, "--version"], env, { deadline: Date.now() + 10_000 })
    .then(() => true, () => false);
  if (await attrSourceSupport) config.unshift(`--attr-source=${emptyTree}`);
  return config;
}

async function untrackedFiles(root: string, run: (args: string[], options?: Partial<GitOptions>) => Promise<GitResult>) {
  const listing = await run(["ls-files", "--others", "--exclude-standard", "-z", "--", "."], { limit: 8 * 1024 * 1024, allowTruncation: true });
  const paths = listing.stdout.toString("utf8").split("\0");
  if (listing.truncated || paths.at(-1) !== "") paths.pop();
  const included: string[] = [];
  const skipped: { path: string; reason: "size" | "count" }[] = [];
  let total = 0;
  for (const path of paths) {
    if (!path) continue;
    if (included.length >= diffLimits.untrackedFiles) {
      skipped.push({ path, reason: "count" });
      continue;
    }
    let size = 0;
    try {
      size = (await lstat(join(root, path))).size;
    } catch {
      continue;
    }
    if (size > diffLimits.untrackedFileBytes || total + size > diffLimits.untrackedBytes) {
      skipped.push({ path, reason: total + size > diffLimits.untrackedBytes && size <= diffLimits.untrackedFileBytes ? "count" : "size" });
      continue;
    }
    total += size;
    included.push(path);
  }
  return { included, skipped, truncated: listing.truncated };
}

/** Diff the current contents of one worktree, including untracked files Git does not ignore, against its base commit. */
export async function diffSource(source: DiffSource, deadline = Date.now() + diffLimits.timeoutMs): Promise<DiffGroup> {
  const group: DiffGroup = { projectId: source.projectId, mode: source.mode, path: source.path,
    ...(source.branch ? { branch: source.branch } : {}), base: source.base, files: [] };
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
    const top = (await runGit(root, ["rev-parse", "--show-toplevel"], plain, { deadline })).stdout.toString("utf8").trim();
    if (await realpath(top) !== root) throw new Error("The task's worktree is not a complete Git worktree.");
    const isolation = await isolationConfig(root, deadline);
    const run = (args: string[], options: Partial<GitOptions> = {}, env = plain) =>
      runGit(root, args, env, { deadline, isolation, ...options });
    const text = async (args: string[], env = plain) => (await run(args, {}, env)).stdout.toString("utf8");
    try {
      await text(["cat-file", "-e", source.base + "^{commit}"]);
    } catch {
      throw new Error("The task's base revision is no longer available in this repository.");
    }
    const untracked = await untrackedFiles(root, (args, options) => run(args, options));

    // Stage into a throwaway index and object directory so the real index and object store stay untouched.
    temporary = await mkdtemp(join(tmpdir(), "orchestra-diff-"));
    const objects = resolve(root, (await text(["rev-parse", "--git-path", "objects"])).trim());
    const temporaryObjects = join(temporary, "objects");
    await mkdir(join(temporaryObjects, "info"), { recursive: true });
    await writeFile(join(temporaryObjects, "info", "alternates"), objects + "\n");
    const env = cleanEnvironment({ GIT_INDEX_FILE: join(temporary, "index"), GIT_OBJECT_DIRECTORY: temporaryObjects });
    const index = resolve(root, (await text(["rev-parse", "--git-path", "index"])).trim());
    try {
      // Starting from the real index keeps Git's stat cache, so unchanged files are not hashed again.
      // Keep the index's own timestamp so Git still re-checks racily clean entries.
      const { atime, mtime } = await stat(index);
      await copyFile(index, join(temporary, "index"));
      await utimes(join(temporary, "index"), atime, mtime);
      await text(["add", "--update", "--", "."], env);
    } catch (error) {
      if (/too long/.test(String((error as Error).message))) throw error;
      await rm(join(temporary, "index"), { force: true });
      await text(["read-tree", "HEAD"], env);
      await text(["add", "--update", "--", "."], env);
    }
    if (untracked.included.length) {
      const list = join(temporary, "untracked");
      await writeFile(list, untracked.included.join("\0") + "\0");
      await text(["add", `--pathspec-from-file=${list}`, "--pathspec-file-nul"], env);
    }

    const common = ["diff", "--cached", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
    const names = parseNameStatus(await text([...common, "--name-status", "-z", source.base, "--"], env));
    const skipped = untracked.skipped.map(({ path, reason }): DiffFile => ({
      path, status: "A", additions: 0, deletions: 0, binary: false, lines: [], skipped: reason,
    }));
    const notices: string[] = [];
    if (untracked.truncated) notices.push("Some untracked files are not listed because there are too many.");
    const untrackedLabel = (count: number) => `${count} untracked ${count === 1 ? "file was" : "files were"}`;
    const tooLarge = untracked.skipped.filter(({ reason }) => reason === "size").length;
    const tooMany = untracked.skipped.length - tooLarge;
    if (tooLarge) notices.push(`${untrackedLabel(tooLarge)} not read because ${tooLarge === 1 ? "it is" : "they are"} over the size limit.`);
    if (tooMany) notices.push(`${untrackedLabel(tooMany)} not read because there are too many untracked files to read.`);
    if (notices.length) group.notices = notices;
    if (!names.length && !skipped.length) return group;
    const counts = names.length ? parseNumstat(await text([...common, "--numstat", "-z", source.base, "--"], env)) : [];
    const patch = names.length
      ? await run([...common, "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", source.base, "--"],
        { limit: diffLimits.patchBytes, allowTruncation: true }, env)
      : { stdout: Buffer.alloc(0), truncated: false };
    const sections = parsePatch(patch.stdout.toString("utf8"), patch.truncated);
    // Git emits name-status, numstat and patch sections in the same order for the same diff options.
    const files = names.map((entry, position) => {
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
    }).concat(skipped);
    group.files = files.slice(0, diffLimits.files);
    if (files.length > group.files.length) group.moreFiles = files.length - group.files.length;
    return group;
  } catch (error) {
    return { ...group, error: error instanceof Error ? error.message : "Orchestra could not compute the changes." };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Shares diff computations between concurrent requests. A request joins a computation only if it started
 * within `freshMs`; otherwise it may have read files before the latest writes, so one fresh computation is
 * queued after it and shared by everyone who asks in the meantime.
 */
export function diffScheduler<T>(compute: (key: string) => Promise<T>, freshMs = 250) {
  const running = new Map<string, { startedAt: number; promise: Promise<T> }>();
  const queued = new Map<string, Promise<T>>();
  const start = (key: string) => {
    const flight = { startedAt: Date.now(), promise: compute(key) };
    running.set(key, flight);
    const clear = () => { if (running.get(key) === flight) running.delete(key); };
    flight.promise.then(clear, clear);
    return flight.promise;
  };
  return (key: string): Promise<T> => {
    const waiting = queued.get(key);
    if (waiting) return waiting;
    const current = running.get(key);
    if (!current) return start(key);
    if (Date.now() - current.startedAt <= freshMs) return current.promise;
    const next = current.promise.then(() => undefined, () => undefined).then(() => {
      queued.delete(key);
      return start(key);
    });
    queued.set(key, next);
    return next;
  };
}

export async function taskDiff(sources: DiffSource[] | "general"): Promise<TaskDiff> {
  if (sources === "general") return { kind: "general" };
  const deadline = Date.now() + diffLimits.timeoutMs;
  const groups: DiffGroup[] = [];
  for (const source of sources) groups.push(await diffSource(source, deadline));
  return { kind: "repositories", groups };
}
