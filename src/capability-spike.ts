import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServer, command, log, safeError, type Thread, type Turn } from "./app-server.ts";

type Selection = { thread: Thread; model: string; modelProvider: string; reasoningEffort?: string };
type Skill = { name: string; path: string; enabled: boolean };
const provider = process.env.CODEX_PROVIDER ?? "openai";
const model = process.env.CODEX_MODEL;
const effort = process.env.CODEX_EFFORT;
const inference = process.argv.includes("--inference");
const root = mkdtempSync(join(tmpdir(), "orchestra-capability-"));
const checkout = join(root, "checkout");
const worktree = join(root, "candidate");
let server: AppServer | undefined;
let stage = "fixture";
const usageCounts = new Map<string, number>();

function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  execFileSync("git", ["-C", cwd, ...args], { env, stdio: "pipe" });
}

async function connect() {
  const connection = new AppServer(checkout);
  server = connection;
  connection.onRequest = async ({ id, method }) => {
    connection.reject(id, "This probe does not grant approvals or run dynamic tools.");
    log("request.rejected", { method });
  };
  connection.onEvent = ({ method, params }) => {
    if (method === "thread/tokenUsage/updated" || method === "model/rerouted") {
      const { threadId, turnId } = params;
      const { tokenUsage, fromModel, toModel } = params as typeof params & {
        tokenUsage?: unknown; fromModel?: string; toModel?: string;
      };
      if (method === "thread/tokenUsage/updated" && threadId && turnId) {
        const key = `${threadId}:${turnId}`;
        usageCounts.set(key, (usageCounts.get(key) ?? 0) + 1);
      }
      log(method, { threadId, turnId, tokenUsage, fromModel, toModel });
    }
  };
  await connection.call("initialize", {
    clientInfo: { name: "orchestra_capability_spike", title: "Orchestra capability spike", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  connection.notify("initialized");
  return connection;
}

async function runTurn(connection: AppServer, threadId: string, marker: string, skill?: Skill) {
  const input = [
    { type: "text", text: skill ? "Use the attached capability-probe skill." : `Reply exactly with ${marker}.`, text_elements: [] },
    ...(skill ? [{ type: "skill", name: skill.name, path: skill.path }] : []),
  ];
  const { turn } = await connection.call<{ turn: Turn }>("turn/start", { threadId, input, effort });
  const completed = await connection.waitFor("probe turn to finish", ({ method, params }) =>
    method === "turn/completed" && params.threadId === threadId && params.turn?.id === turn.id);
  const matched = connection.matchingEvents(({ method, params }) =>
    method === "item/completed" && params.threadId === threadId && params.turnId === turn.id &&
    params.item?.type === "agentMessage" && params.item.text?.trim() === marker).length > 0;
  log("turn.result", { threadId, turnId: turn.id, status: completed.params.turn?.status, matched,
    usageUpdatesAtCompletion: usageCounts.get(`${threadId}:${turn.id}`) ?? 0 });
  if (completed.params.turn?.status !== "completed") {
    throw new Error(completed.params.turn?.error?.message ?? "Turn did not complete.");
  }
  if (!matched) throw new Error("Assistant response did not match the expected marker.");
}

try {
  const skillPath = ".agents/skills/orchestra-capability-probe";
  const skillName = "orchestra-capability-probe";
  const skillMarker = "ORCHESTRA_SKILL_OK";
  mkdirSync(join(checkout, skillPath), { recursive: true });
  writeFileSync(join(checkout, skillPath, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Verify explicit skill invocation.\n---\nReply exactly with ${skillMarker}.\n`);
  git(checkout, "init", "--quiet");
  git(checkout, "add", "--force", skillPath);
  git(checkout, "-c", "user.name=Orchestra", "-c", "user.email=probe@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Add probe skill");
  git(checkout, "worktree", "add", "--quiet", "--detach", worktree, "HEAD");
  log("probe.start", { version: execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(),
    provider, model, effort, inference });

  stage = "initialize";
  const connection = await connect();
  stage = "model/list";
  const catalog = await connection.call<{ data: { model: string; defaultReasoningEffort?: string }[]; nextCursor?: string }>(
    "model/list", { limit: 20 });
  log("catalog.page", { models: catalog.data.map(({ model, defaultReasoningEffort }) => ({ model, defaultReasoningEffort })),
    more: Boolean(catalog.nextCursor) });

  stage = "skills/list";
  const { data } = await connection.call<{ data: { cwd: string; skills: Skill[] }[] }>(
    "skills/list", { cwds: [checkout, worktree], forceReload: true });
  const fixtureSkill = (cwd: string) => data.find((entry) => entry.cwd === cwd)?.skills.find((skill) =>
    skill.name === skillName && skill.enabled && skill.path === join(cwd, skillPath, "SKILL.md"));
  const skill = fixtureSkill(worktree);
  log("skills.fixture", { checkout: Boolean(fixtureSkill(checkout)), worktree: Boolean(skill) });

  const settings = { cwd: worktree, model, modelProvider: provider, sandbox: "read-only", approvalPolicy: "never" };
  stage = "thread/start";
  const selected = await connection.call<Selection>("thread/start", { ...settings, ephemeral: !inference });
  log("thread.started", { threadId: selected.thread.id, model: selected.model, provider: selected.modelProvider,
    effort: selected.reasoningEffort });
  if (selected.modelProvider !== provider) throw new Error("App Server selected a different provider.");
  if (model && selected.model !== model) throw new Error("App Server reported a different model from the explicit request.");

  if (inference) {
    stage = "first turn";
    await runTurn(connection, selected.thread.id, "ORCHESTRA_FIRST_OK");
    await connection.close();
    stage = "reconnect";
    const resumedConnection = await connect();
    stage = "thread/resume";
    const resumed = await resumedConnection.call<Selection>("thread/resume", {
      ...settings, threadId: selected.thread.id, model: selected.model,
    });
    log("thread.resumed", { threadId: resumed.thread.id, model: resumed.model, provider: resumed.modelProvider,
      effort: resumed.reasoningEffort });
    if (resumed.thread.id !== selected.thread.id || resumed.modelProvider !== provider || resumed.model !== selected.model) {
      throw new Error("Resume returned a different thread, provider or model.");
    }
    stage = "resumed turn";
    await runTurn(resumedConnection, resumed.thread.id, "ORCHESTRA_RESUMED_OK");
    stage = "skill invocation";
    if (!skill) throw new Error("The candidate worktree skill was not discovered.");
    await runTurn(resumedConnection, resumed.thread.id, skillMarker, skill);
  }
  log("probe.completed", { inference });
} catch (error) {
  const summary = safeError(error);
  const category = summary.match(/RPC -?\d+|Timed out|\bEPERM\b/)?.[0] ?? "Probe check failed";
  log("probe.failed", { stage, category, ...(process.env.CODEX_PROBE_DEBUG === "1" && { error: summary }) });
  process.exitCode = 1;
} finally {
  try {
    await server?.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
