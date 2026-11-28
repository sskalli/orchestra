// What a task may do without asking, and how the Claude engine explains the requests it does pass on.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Package registries that repository tasks may reach without asking, besides their Git remotes. */
const packageRegistries = ["registry.npmjs.org", "registry.yarnpkg.com"];

/**
 * Tool caches that sandboxed commands may write in repository tasks. Package managers and tools such as Prisma
 * and Playwright fail or re-download everything when their cache in the home folder is read-only.
 */
export function toolCacheFolders(home = homedir(), platform = process.platform) {
  const folders = [join(home, ".npm"), join(home, ".cache"), join(home, ".bun", "install", "cache"), join(home, ".yarn", "berry", "cache")];
  if (platform === "darwin") folders.push(join(home, "Library", "Caches"));
  return folders.filter((folder) => existsSync(folder));
}

/** The host of a Git remote URL: https://host/…, ssh://user@host/… or user@host:path. Local paths have none. */
export function remoteHost(url: string) {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)/i.exec(trimmed);
  if (scheme) return /^(https?|ssh|git)$/i.test(scheme[1]) ? scheme[2].toLowerCase() : undefined;
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):/.exec(trimmed);
  return scp && scp[1].includes(".") ? scp[1].toLowerCase() : undefined;
}

const remoteHosts = new Map<string, string[]>();

/** Hosts a repository task may reach without asking: its repositories' Git remotes and the package registries. */
export function allowedHosts(repositories: string[]) {
  const hosts = new Set(packageRegistries);
  for (const repository of repositories) {
    let found = remoteHosts.get(repository);
    if (!found) {
      try {
        const output = execFileSync("git", ["-C", repository, "remote", "-v"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
        found = [...new Set(output.split("\n").map((line) => remoteHost(line.split(/\s+/)[1] ?? "")).filter((host): host is string => !!host))];
      } catch {
        found = [];
      }
      remoteHosts.set(repository, found);
    }
    for (const host of found) hosts.add(host);
  }
  return [...hosts].sort();
}

/** Claude Code asks about commands it cannot analyse before they run; these are the reasons it gives. */
const uncheckableCommand = /can't be checked|cannot be checked|obfuscation|command substitution|parenthes|brace|variable|heredoc|unparseable|could not be parsed/i;

export type ApprovalRequest = {
  toolName: string;
  input: Record<string, unknown>;
  /** The turn may write its repositories, so sandboxed commands run without asking. */
  writeTurn: boolean;
  decisionReason?: string;
  blockedPath?: string;
  /** Claude Code's own one-line prompt and subtitle, when it provides them. */
  title?: string;
  description?: string;
  /** The background agent that asked, by its description, or "" when its description is unknown. */
  requestedBy?: string;
};

export type ApprovalExplanation = { summary: string; reason: string; host?: string };

const quoted = (text: string) => `“${text.replace(/\s+/g, " ").trim().slice(0, 300)}”`;

/** A headline and a plain explanation of why the user is being asked, for the approval card. */
export function explainApproval(request: ApprovalRequest): ApprovalExplanation {
  const { toolName, input, writeTurn, decisionReason, blockedPath } = request;
  const parts: string[] = [];
  let summary: string;
  let host: string | undefined;
  if (toolName === "SandboxNetworkAccess") {
    host = typeof input.host === "string" ? input.host : undefined;
    summary = host ? `Permission requested to connect to ${host}.` : "Permission requested for network access.";
    parts.push(`A command running in the sandbox wants to reach ${host ?? "a host"}, which this task is not allowed to reach yet.`,
      "Allow for this task lets later commands reach it without asking.");
  } else if (toolName === "Bash") {
    const outside = input.dangerouslyDisableSandbox === true;
    summary = outside ? "Permission requested to run a command outside the sandbox." : "Permission requested to run a command.";
    if (outside) {
      parts.push("The agent asked to run this command without the sandbox. It could then change any file your user account can and reach any host.");
    } else if (!writeTurn) {
      parts.push("This chat has no write access, so it asks before commands that Claude Code can't confirm only read files.");
    }
    if (decisionReason && uncheckableCommand.test(decisionReason)) {
      parts.push("Claude Code can't check what this command does before it runs, because it uses variables, loops, substitutions or an inline script.");
    } else if (blockedPath) {
      parts.push(`It uses a path outside this task's folders: ${blockedPath}.`);
    } else if (decisionReason && !outside) parts.push(`Claude Code: ${decisionReason}`);
    if (typeof input.description === "string" && input.description.trim()) parts.push(`The agent describes it as ${quoted(input.description)}.`);
  } else if (toolName === "WebFetch" && typeof input.url === "string") {
    let site = input.url;
    try { site = new URL(input.url).host || input.url; } catch {}
    summary = `Permission requested to fetch a page from ${site}.`;
    parts.push(`The agent wants to read ${input.url} with WebFetch, which runs outside the sandbox and is not covered by the task's allowed hosts.`);
  } else if (toolName === "WebSearch") {
    summary = "Permission requested to search the web.";
    parts.push("The agent wants to run a web search, which sends the query to the search provider.");
  } else if (blockedPath) {
    summary = request.title ?? `Permission requested to use ${toolName} outside this task's folders.`;
    parts.push(`It needs ${blockedPath}, which is outside this task's folders.`);
  } else {
    summary = request.title ?? `Permission requested to use ${toolName}.`;
    if (request.description) parts.push(request.description);
    if (decisionReason) parts.push(`Claude Code: ${decisionReason}`);
  }
  if (request.requestedBy !== undefined) {
    parts.unshift(request.requestedBy ? `Asked by the background agent ${quoted(request.requestedBy)}.` : "Asked by a background agent.");
  }
  return { summary, reason: parts.join(" "), ...(host ? { host } : {}) };
}
