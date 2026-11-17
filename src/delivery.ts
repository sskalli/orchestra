import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AppServer, command, log, safeError, timeoutMs } from "./app-server.ts";
import type { Thread, Turn } from "./app-server.ts";

const features = {
  completed: {
    goal: 'Append " (completed)" to the title when task.completed is true.',
    expression: 'task.title + (task.completed === true ? " (completed)" : "")',
  },
  priority: {
    goal: 'Prefix the title with "[High] " when task.priority is "high".',
    expression: '(task.priority === "high" ? "[High] " : "") + task.title',
  },
};
type Feature = keyof typeof features;
const renderTask = (expression: string) =>
  `export function renderTask(task) {\n  return ${expression};\n}\n`;
const combinedExpression = '(task.priority === "high" ? "[High] " : "") + task.title + (task.completed === true ? " (completed)" : "")';

const checks = `import assert from "node:assert/strict";
import { renderTask } from "./task.mjs";

const cases = {
  base: [[{ title: "Task" }, "Task"]],
  completed: [[{ title: "Task", completed: true }, "Task (completed)"]],
  priority: [[{ title: "Task", priority: "high" }, "[High] Task"]],
  combined: [[{ title: "Task", completed: true, priority: "high" }, "[High] Task (completed)"]],
};
for (const [task, expected] of [...cases.base, ...cases[process.argv[2]]]) {
  assert.equal(renderTask(task), expected);
}
console.log("check passed: " + process.argv[2]);
`;

const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
fixtureEnv.GIT_CONFIG_NOSYSTEM = "1";
fixtureEnv.GIT_CONFIG_GLOBAL = "/dev/null";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: fixtureEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function check(cwd: string, scenario: Feature | "combined") {
  execFileSync(process.execPath, ["check.mjs", scenario], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return `check passed: ${scenario}`;
}

async function createFixture(directory: string) {
  const root = join(directory, "project");
  git(directory, "init", "--template=", "--initial-branch=main", root);
  git(root, "config", "user.name", "Orchestra Fixture");
  git(root, "config", "user.email", "fixture@orchestra.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  await writeFile(join(root, "task.mjs"), renderTask("task.title"));
  await writeFile(join(root, "check.mjs"), checks);
  git(root, "add", "task.mjs", "check.mjs");
  git(root, "commit", "-m", "Create task rendering fixture");
  const base = git(root, "rev-parse", "main");
  const worktrees = {
    completed: join(directory, "completed"),
    priority: join(directory, "priority"),
    candidate: join(directory, "candidate"),
  };
  for (const [branch, path] of Object.entries(worktrees)) {
    git(root, "worktree", "add", "-b", branch, path, base);
  }
  return { root, base, worktrees };
}

const toolDescriptions = {
  start_squads: "Run the two parallel feature squads and prepare their combined candidate for review.",
  inspect_task: "Read task.mjs and its Git diff in the worktree assigned to this turn.",
  submit_task_source: "Write the supplied complete task.mjs source to the worktree assigned to this turn.",
  run_task_check: "Run the fixed task rendering check for the squad assigned to this turn.",
};
type ToolName = keyof typeof toolDescriptions;
type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;
type TurnTools = Partial<Record<ToolName, ToolHandler>>;

function toolSpec(name: ToolName) {
  return {
    type: "function",
    name,
    description: toolDescriptions[name],
    inputSchema: {
      type: "object",
      properties: name === "submit_task_source" ? { source: { type: "string" } } : {},
      required: name === "submit_task_source" ? ["source"] : [],
      additionalProperties: false,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type DeliveryThread = { id: string; cwd: string };
type ActiveTurn = {
  role: string;
  id?: string;
  tools: TurnTools;
  called: Set<ToolName>;
  succeeded: Set<ToolName>;
};

class Delivery {
  private readonly server: AppServer;
  private readonly fixture: Fixture;
  private leadTurn?: string;
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(server: AppServer, fixture: Fixture) {
    this.server = server;
    this.fixture = fixture;
    server.onRequest = async ({ id, method, params }) => {
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        server.reply(id, { decision: "decline" });
        return;
      }
      if (method !== "item/tool/call") {
        server.reject(id, "Unexpected delivery request");
        return;
      }
      const active = params.threadId ? this.activeTurns.get(params.threadId) : undefined;
      const name = params.tool as ToolName;
      const handler = active && Object.hasOwn(active.tools, name) ? active.tools[name] : undefined;
      const reply = (success: boolean, text: string) =>
        server.reply(id, { success, contentItems: [{ type: "inputText", text }] });
      if (!active || !active.id || active.id !== params.turnId || params.namespace != null ||
          !handler || active.called.has(name)) {
        reply(false, "Tool unavailable for this delivery turn.");
        return;
      }
      if (name === "submit_task_source" && active.tools.inspect_task && !active.succeeded.has("inspect_task")) {
        reply(false, "Inspect the conflict before submitting its resolution.");
        return;
      }
      active.called.add(name);
      try {
        const result = await handler(params.arguments ?? {});
        active.succeeded.add(name);
        log("delivery.tool.completed", { role: active.role, threadId: params.threadId, turnId: active.id, tool: name });
        reply(true, result);
      } catch (error) {
        log("delivery.tool.failed", { role: active.role, turnId: active.id, tool: name, message: safeError(error) });
        if (name !== "start_squads") active.called.delete(name);
        reply(false, safeError(error));
      }
    };
    server.onEvent = ({ method, params }) => {
      const active = params.threadId ? this.activeTurns.get(params.threadId) : undefined;
      if (method === "turn/started" && active && params.turn) {
        active.id ??= params.turn.id;
        if (active.role === "lead") this.leadTurn = active.id;
      }
      if (method === "error") {
        log("delivery.provider.error", { threadId: params.threadId, turnId: params.turnId, message: safeError(params.error?.message ?? params.message) });
      }
    };
  }

  private async startThread(role: string, cwd: string, tools: ToolName[]) {
    const { thread, modelProvider } = await this.server.call<{ thread: Thread; modelProvider: string }>("thread/start", {
      cwd,
      model: process.env.CODEX_MODEL,
      modelProvider: "openai",
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      dynamicTools: tools.map(toolSpec),
    });
    assert.equal(modelProvider, "openai");
    log("delivery.thread.started", { role, cwd, threadId: thread.id });
    return { id: thread.id, cwd };
  }

  private async runTurn(role: string, { id: threadId, cwd }: DeliveryThread, prompt: string, tools: TurnTools = {}) {
    assert(!this.activeTurns.has(threadId), `A turn is already active for ${role}`);
    const active: ActiveTurn = { role, tools, called: new Set(), succeeded: new Set() };
    this.activeTurns.set(threadId, active);
    try {
      return await this.completeTurn(role, threadId, cwd, prompt, active);
    } finally {
      this.activeTurns.delete(threadId);
    }
  }

  private async completeTurn(role: string, threadId: string, cwd: string, prompt: string, active: ActiveTurn) {
    const { turn } = await this.server.call<{ turn: Turn }>("turn/start", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      parentTurnId: role === "lead" ? undefined : this.leadTurn,
      rootTurnId: role === "lead" ? undefined : this.leadTurn,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      effort: "low",
    });
    active.id ??= turn.id;
    assert.equal(active.id, turn.id);
    if (role === "lead") this.leadTurn = turn.id;
    const completion = await this.server.waitFor(`${role} completion`, (event) =>
      event.method === "turn/completed" && event.params.threadId === threadId && event.params.turn?.id === turn.id);
    assert.equal(completion.params.turn?.status, "completed", safeError(completion.params.turn?.error?.message));
    const messages = this.server.matchingEvents((event) =>
      event.method === "item/completed" && event.params.threadId === threadId &&
      event.params.turnId === turn.id && event.params.item?.type === "agentMessage");
    const reply = messages.at(-1)?.params.item?.text?.trim();
    assert(reply, `Missing reply from ${role}`);
    log("delivery.turn.completed", { role, threadId, turnId: turn.id, reply: safeError(reply) });
    for (const name of Object.keys(active.tools) as ToolName[]) {
      assert(active.succeeded.has(name), `${role} finished without a successful ${name} tool call`);
    }
    return reply;
  }

  private inspectTask(cwd: string): ToolHandler {
    return async () => JSON.stringify({
      source: await readFile(join(cwd, "task.mjs"), "utf8"),
      diff: git(cwd, "diff", "--", "task.mjs"),
    });
  }

  private submitTask(cwd: string, expression: string): ToolHandler {
    return async ({ source }) => {
      assert(typeof source === "string", "Supply the complete task.mjs source.");
      assert(source.trimEnd() === renderTask(expression).trimEnd(), "The submitted source does not match the fixture assignment.");
      await writeFile(join(cwd, "task.mjs"), source.trimEnd() + "\n");
      return "Wrote task.mjs in the assigned worktree.";
    };
  }

  private async squad(feature: Feature) {
    const cwd = this.fixture.worktrees[feature];
    const { goal, expression } = features[feature];
    const developer = `${feature}.implementation`;
    await this.runTurn(developer, await this.startThread(developer, cwd, ["submit_task_source"]),
      `Implement this fixture feature: ${goal} The existing source is ${JSON.stringify(renderTask("task.title"))}. Call submit_task_source with the complete source as a string, preserving the wrapper and replacing the return expression with exactly ${expression}. Use the app tool without shell or apply_patch. Reply when the change is on disk.`,
      { submit_task_source: this.submitTask(cwd, expression) });
    assert.equal(await readFile(join(cwd, "task.mjs"), "utf8"), renderTask(expression));
    assert.equal(git(cwd, "status", "--porcelain"), "M task.mjs");
    const reviewer = `${feature}.review`;
    const tester = `${feature}.test`;
    const [reviewThread, testThread] = await Promise.all([
      this.startThread(reviewer, cwd, ["inspect_task"]),
      this.startThread(tester, cwd, ["run_task_check"]),
    ]);
    const [review, test] = await Promise.all([
      this.runTurn(reviewer, reviewThread,
        `Call inspect_task to review the task.mjs diff against this requirement: ${goal} Use the app tool without shell. Finish with REVIEW_PASSED on a separate line if it meets the requirement, otherwise describe the issue.`,
        { inspect_task: this.inspectTask(cwd) }),
      this.runTurn(tester, testThread,
        "Call run_task_check to run the fixture check. Use the app tool without shell. Finish with TEST_PASSED on a separate line only if the check passed.",
        { run_task_check: () => check(cwd, feature) }),
    ]);
    assert(review.split("\n").includes("REVIEW_PASSED"), `Review failed for ${feature}`);
    assert(test.split("\n").includes("TEST_PASSED"), `Test failed for ${feature}`);
    const result = check(cwd, feature);
    git(cwd, "add", "task.mjs");
    git(cwd, "commit", "-m", `Implement ${feature} task rendering`);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    return { feature, commit: git(cwd, "rev-parse", "HEAD"), review, test, result };
  }

  private prepareIntegration() {
    const { root, base, worktrees: { candidate } } = this.fixture;
    assert.equal(git(root, "rev-parse", "main"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
    git(candidate, "merge", "--ff-only", "completed");
    assert.throws(() => check(candidate, "combined"), /\[High\] Task \(completed\)/);
    log("delivery.check.failed", { check: "combined", reason: "The completed-only candidate lacks the priority prefix." });
    assert.throws(() => git(candidate, "merge", "--no-edit", "priority"), { status: 1 });
    assert.equal(git(candidate, "diff", "--name-only", "--diff-filter=U"), "task.mjs");
    log("delivery.conflict", { path: "task.mjs" });
  }

  private async finalizeIntegration() {
    const { root, base, worktrees: { candidate } } = this.fixture;
    assert.equal(await readFile(join(candidate, "task.mjs"), "utf8"), renderTask(combinedExpression));
    assert.equal(git(candidate, "status", "--porcelain"), "UU task.mjs");
    git(candidate, "add", "task.mjs");
    git(candidate, "commit", "-m", "Integrate completed and priority task rendering");
    const results = [check(candidate, "completed"), check(candidate, "priority"), check(candidate, "combined")];
    assert.equal(git(candidate, "status", "--porcelain"), "");
    const revision = git(candidate, "rev-parse", "HEAD");
    assert.equal(git(root, "rev-parse", "main"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
    const report = { base, revision, results, diff: git(candidate, "diff", base, revision) };
    log("delivery.candidate", report);
    return report;
  }

  async run() {
    const candidate = this.fixture.worktrees.candidate;
    const lead = await this.startThread("lead", this.fixture.root, ["start_squads", "inspect_task", "submit_task_source"]);
    await this.runTurn("lead", lead,
      "You are the team lead for this two-feature fixture roadmap: completed-task rendering and high-priority task rendering. First call start_squads exactly once to delegate both features, including independent review and testing. After the tool returns, summarize the squad outcomes and the integration conflict. Do not use any other tools yet.", {
        start_squads: async () => {
          const outcomes = await Promise.allSettled([this.squad("completed"), this.squad("priority")]);
          const reports = outcomes.map((outcome) => {
            if (outcome.status === "rejected") throw outcome.reason;
            return outcome.value;
          });
          this.prepareIntegration();
          return JSON.stringify({
            reports,
            candidateWorktree: candidate,
            failingCheck: "The completed-only candidate lacks the priority prefix.",
            conflict: "task.mjs",
          });
        },
      });
    await this.runTurn("lead.integration", { ...lead, cwd: candidate },
      `Call inspect_task to read the conflict in the candidate worktree and wait for its result. Resolve task.mjs by calling submit_task_source with the complete source as a string, keeping the original export and both features. Remove the Git conflict markers and use exactly this return expression: ${combinedExpression}. Use the app tools without shell or apply_patch. Reply once the resolution is on disk.`,
      { inspect_task: this.inspectTask(candidate), submit_task_source: this.submitTask(candidate, combinedExpression) });
    const report = await this.finalizeIntegration();
    await this.runTurn("lead.summary", lead,
      `Present the verified candidate for user approval. Summarize its diff, the recovered conflict, and the failed and passing checks. Do not merge it or use tools. Verified report: ${JSON.stringify(report)}`);
    return report.revision;
  }
}

async function main() {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647, "Invalid CODEX_TIMEOUT_MS");
  const codex = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  log("runtime.version", { codex, node: process.version });
  const directory = await mkdtemp(join(tmpdir(), "orchestra-delivery-"));
  try {
    const fixture = await createFixture(directory);
    const server = new AppServer(fixture.root, fixtureEnv);
    let candidate: string;
    try {
      await server.call("initialize", {
        clientInfo: { name: "orchestra_delivery", title: "Orchestra Delivery", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      server.notify("initialized");
      const { account } = await server.call<{ account: { type: string; planType?: string } | null }>("account/read", { refreshToken: false });
      assert.equal(account?.type, "chatgpt", "Sign in to Codex with ChatGPT before running the delivery exercise");
      log("delivery.account", { authType: account.type, planType: account.planType });
      candidate = await new Delivery(server, fixture).run();
    } finally {
      await server.close();
    }
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
    assert.equal(git(fixture.root, "status", "--porcelain"), "");
    if (!process.stdin.isTTY) {
      log("delivery.approval.pending", { candidate, fixtureMain: fixture.base });
      return;
    }
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question(`Type "merge ${candidate}" to approve the candidate on the disposable fixture's main branch, or press Enter to decline.\n`);
      if (answer !== `merge ${candidate}`) {
        log("delivery.approval.declined", { fixtureMain: fixture.base });
        return;
      }
    } finally {
      terminal.close();
    }
    assert.equal(git(fixture.root, "rev-parse", "main"), fixture.base);
    git(fixture.root, "merge", "--ff-only", candidate);
    assert.equal(git(fixture.root, "rev-parse", "main"), candidate);
    assert.equal(git(fixture.root, "status", "--porcelain"), "");
    log("delivery.passed", { fixtureMain: candidate });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  log("delivery.failed", { message: safeError(error) });
  process.exitCode = 1;
});
