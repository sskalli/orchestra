import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Branch and remote-tracking tips of one repository, keyed by ref name. */
export type RefState = Map<string, { sha: string; subject: string }>;

const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

async function git(repository: string, ...args: string[]) {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repository, env: gitEnvironment(), encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function quietly<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

/** The repository's shared Git directory, which linked worktrees write their commits and refs to. */
export function gitCommonDirectory(repository: string) {
  return quietly(async () => {
    const path = (await git(repository, "rev-parse", "--git-common-dir")).trim();
    return path ? (isAbsolute(path) ? path : resolve(repository, path)) : undefined;
  });
}

/** Reads branch and remote-tracking tips; a repository Git cannot read reports nothing. */
export function readRefState(repository: string): Promise<RefState | undefined> {
  return quietly(async () => {
    const output = await git(repository, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(subject)", "refs/heads", "refs/remotes");
    const refs: RefState = new Map();
    for (const line of output.split("\n")) {
      const [ref, sha, ...subject] = line.split("\t");
      if (ref && sha && !ref.endsWith("/HEAD")) refs.set(ref, { sha, subject: subject.join("\t") });
    }
    return refs;
  });
}

export type WorktreeEntry = { path: string; head?: string; branch?: string; main?: true };

/** The repository's worktrees, the main checkout first and marked as such. */
export function listWorktrees(repository: string): Promise<WorktreeEntry[] | undefined> {
  return quietly(async () => {
    const entries: WorktreeEntry[] = [];
    for (const block of (await git(repository, "worktree", "list", "--porcelain")).split("\n\n")) {
      const entry: WorktreeEntry = { path: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
        else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
        else if (line.startsWith("branch ")) entry.branch = line.slice("branch refs/heads/".length);
      }
      if (entry.path) entries.push(entries.length ? entry : { ...entry, main: true });
    }
    return entries;
  });
}

/** Where a worktree's branch left the line it was cut from, to diff only its own changes. */
export function forkPoint(repository: string, head: string, from: string) {
  return quietly(async () => (await git(repository, "merge-base", head, from)).trim() || undefined);
}

/**
 * Records the checkout's tracked contents, uncommitted edits included, as a commit kept under an Orchestra ref,
 * so the task's own edits can be told apart from what was already there. A clean checkout records its HEAD.
 */
export function snapshotCheckout(repository: string, ref: string) {
  return quietly(async () => {
    const head = (await git(repository, "rev-parse", "--verify", "HEAD^{commit}")).trim();
    const snapshot = (await git(repository, "stash", "create", "Orchestra task start")).trim() || head;
    if (snapshot !== head) await git(repository, "update-ref", "-m", "Orchestra task start", ref, snapshot);
    return snapshot;
  });
}

/** Removes a ref Orchestra kept, such as a task's start snapshot. */
export async function deleteRef(repository: string, ref: string) {
  await quietly(() => git(repository, "update-ref", "-d", ref));
}

/** Why a ref moved since the given commit, newest first, from Git's own log of the ref. */
async function refUpdates(repository: string, ref: string, since?: string) {
  const output = await quietly(() => git(repository, "reflog", "show", "-n", "50", "--format=%H%x09%gs", ref, "--"));
  const updates: string[] = [];
  for (const line of output?.split("\n") ?? []) {
    const [sha, ...reason] = line.split("\t");
    if (!sha) continue;
    if (since && sha === since) break;
    updates.push(reason.join("\t"));
  }
  return updates;
}

export type GitNote = { text: string; branch: string };

/**
 * Describes commits, new branches and pushes between two readings. Git's reflog says why each ref moved, so a pull,
 * fetch or reset is not reported as the task's commit or push. `includes` decides which branches belong to the task.
 */
export async function describeGitActivity(repository: string, label: string, before: RefState, after: RefState,
  includes: (branch: string) => boolean = () => true): Promise<GitNote[]> {
  const notes: GitNote[] = [];
  for (const [ref, tip] of after) {
    const previous = before.get(ref);
    if (previous?.sha === tip.sha) continue;
    const short = tip.sha.slice(0, 7);
    const subject = tip.subject ? ` ${tip.subject}` : "";
    if (ref.startsWith("refs/heads/")) {
      const branch = ref.slice("refs/heads/".length);
      if (!includes(branch)) continue;
      const updates = await refUpdates(repository, ref, previous?.sha);
      const commits = updates.filter((reason) => /^commit\b/.test(reason)).length;
      const integrated = updates.find((reason) => /^(merge|rebase)\b/.test(reason));
      if (!previous) notes.push({ branch, text: `Created branch \`${branch}\` in ${label} at \`${short}\`${subject}` });
      else if (commits) {
        notes.push({ branch, text: `Committed ${commits === 1 ? "1 commit" : `${commits} commits`} on \`${branch}\` in ${label}: \`${short}\`${subject}` });
      } else if (integrated) {
        notes.push({ branch, text: `Updated \`${branch}\` in ${label} by ${integrated.split(/[:( ]/)[0]} to \`${short}\`${subject}` });
      }
    } else if (ref.startsWith("refs/remotes/")) {
      const [remote, ...rest] = ref.slice("refs/remotes/".length).split("/");
      const branch = rest.join("/");
      if (!branch || !includes(branch)) continue;
      const updates = await refUpdates(repository, ref, previous?.sha);
      if (!updates.some((reason) => reason.startsWith("update by push"))) continue;
      notes.push({ branch, text: previous
        ? `Pushed \`${branch}\` in ${label} to ${remote} at \`${short}\``
        : `Published branch \`${branch}\` in ${label} to ${remote} at \`${short}\`` });
    }
  }
  return notes;
}
