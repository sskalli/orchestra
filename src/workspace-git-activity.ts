import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/** Branch and remote-tracking tips of one repository, keyed by ref name. */
export type RefState = Map<string, { sha: string; subject: string }>;

const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function git(repository: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repository, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
  });
}

/** The repository's shared Git directory, which linked worktrees write their commits and refs to. */
export function gitCommonDirectory(repository: string) {
  try {
    const path = git(repository, "rev-parse", "--git-common-dir").trim();
    return path ? (isAbsolute(path) ? path : resolve(repository, path)) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads branch and remote-tracking tips; a repository Git cannot read reports nothing. */
export function readRefState(repository: string): RefState | undefined {
  try {
    const output = git(repository, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(subject)", "refs/heads", "refs/remotes");
    const refs: RefState = new Map();
    for (const line of output.split("\n")) {
      const [ref, sha, ...subject] = line.split("\t");
      if (ref && sha && !ref.endsWith("/HEAD")) refs.set(ref, { sha, subject: subject.join("\t") });
    }
    return refs;
  } catch {
    return undefined;
  }
}

function commitCount(repository: string, from: string, to: string) {
  try {
    return Number(git(repository, "rev-list", "--count", `${from}..${to}`).trim()) || undefined;
  } catch {
    return undefined;
  }
}

/** Describes new commits on local branches and branches pushed to a remote between two readings. */
export function describeGitActivity(repository: string, label: string, before: RefState, after: RefState) {
  const notes: string[] = [];
  for (const [ref, tip] of after) {
    const previous = before.get(ref);
    if (previous?.sha === tip.sha) continue;
    const short = tip.sha.slice(0, 7);
    if (ref.startsWith("refs/heads/")) {
      const branch = ref.slice("refs/heads/".length);
      if (!previous) {
        notes.push(`Created branch \`${branch}\` in ${label} at \`${short}\` ${tip.subject}`.trimEnd());
        continue;
      }
      const count = commitCount(repository, previous.sha, tip.sha);
      notes.push(count
        ? `Committed ${count === 1 ? "1 commit" : `${count} commits`} on \`${branch}\` in ${label}: \`${short}\` ${tip.subject}`.trimEnd()
        : `Moved \`${branch}\` in ${label} to \`${short}\` ${tip.subject}`.trimEnd());
    } else if (ref.startsWith("refs/remotes/")) {
      const [remote, ...rest] = ref.slice("refs/remotes/".length).split("/");
      const branch = rest.join("/");
      // A fetch also moves remote-tracking refs; a push leaves them on a local branch's tip.
      if (!branch || after.get(`refs/heads/${branch}`)?.sha !== tip.sha) continue;
      notes.push(previous
        ? `Pushed \`${branch}\` in ${label} to ${remote} at \`${short}\``
        : `Published branch \`${branch}\` in ${label} to ${remote} at \`${short}\``);
    }
  }
  return notes;
}
