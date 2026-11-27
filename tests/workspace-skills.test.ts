import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeAppServer } from "../src/claude-app-server.ts";
import { SkillCatalog, normalizeSkills, skillInputFor } from "../src/workspace-skills.ts";
import { workspaceStore } from "../src/workspace-store.ts";

process.env.CODEX_BIN = fileURLToPath(new URL("./fixtures/fake-codex-task-questions.mjs", import.meta.url));
const { WorkspaceRuntime } = await import("../src/workspace-runtime.ts");

test("provider skill lists are flattened, deduplicated, and stripped of disabled entries", () => {
  assert.deepEqual(normalizeSkills({ data: [
    { skills: [
      { name: "pdf:pdf", description: "Long", interface: { shortDescription: "Short" }, path: "/a/SKILL.md", enabled: true },
      { name: "off", description: "Disabled", enabled: false },
      { name: "bad name", description: "Spaces are not typable" },
    ] },
    { skills: [{ name: "pdf:pdf", description: "Duplicate" }, { name: "review", description: " Review ", argumentHint: "[pr]" }] },
  ] }), [
    { name: "pdf:pdf", description: "Short", path: "/a/SKILL.md" },
    { name: "review", description: "Review", argumentHint: "[pr]" },
  ]);
  assert.deepEqual(normalizeSkills(undefined), []);
});

test("a leading /skill maps to a Codex skill item only for listed skills with a path", () => {
  const skills = [{ name: "pdf", description: "", path: "/p/SKILL.md" }, { name: "builtin", description: "" }];
  assert.deepEqual(skillInputFor("/pdf summarize report.pdf", skills), [{ type: "skill", name: "pdf", path: "/p/SKILL.md" }]);
  assert.deepEqual(skillInputFor("/pdf", skills), [{ type: "skill", name: "pdf", path: "/p/SKILL.md" }]);
  assert.deepEqual(skillInputFor("/pdfx", skills), []);
  assert.deepEqual(skillInputFor("please /pdf", skills), []);
  assert.deepEqual(skillInputFor("/builtin", skills), []);
  assert.deepEqual(skillInputFor("/pdf", undefined), []);
});

test("the skill catalog caches briefly, shares one load, and reloads after invalidation", async () => {
  let now = 0;
  let loads = 0;
  const catalog = new SkillCatalog(async () => [{ name: `skill-${++loads}`, description: "" }], () => now);
  const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(loads, 1);
  assert.equal(first, second);
  now = 59_000;
  await catalog.list();
  assert.equal(loads, 1);
  now = 61_000;
  assert.equal((await catalog.list())[0].name, "skill-2");
  catalog.invalidate();
  assert.equal(catalog.known?.[0].name, "skill-2", "the last list stays known for matching messages");
  assert.equal((await catalog.list())[0].name, "skill-3");
});

test("Codex skills come from skills/list and a typed /skill message carries its skill item", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "orchestra-skills-"));
  const tracePath = join(project, "provider.jsonl");
  process.env.ORCHESTRA_TEST_TRACE = tracePath;
  const runtime = new WorkspaceRuntime({ cwd: project, store: workspaceStore(project, join(project, "state")) });
  t.after(async () => {
    await runtime.close();
    delete process.env.ORCHESTRA_TEST_TRACE;
    rmSync(project, { recursive: true, force: true });
  });
  await runtime.start();
  assert.equal(runtime.snapshot().provider.state, "ready", runtime.snapshot().provider.message);
  assert.deepEqual(await runtime.skills(), [{ name: "release-notes", description: "Draft release notes", path: "/skills/release-notes/SKILL.md" }]);
  const trace = () => readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const projectId = runtime.snapshot().projects[0].id;
  const listCalls = () => trace().filter(({ method }) => method === "skills/list").map(({ params }) => params);
  assert.deepEqual(listCalls(), [{ cwds: [tmpdir()] }], "only the general scope is listed at startup");
  await assert.rejects(runtime.skills(["missing"]), /Unknown repository/);

  // Nobody opened the menu for this repository, so the first "/skill" message loads that scope's list.
  const taskId = String(await runtime.command({ type: "createTask", name: "Skills", projectIds: [projectId] }));
  const replies = () => runtime.snapshot().agents.find(({ id }) => id === taskId)!.messages.filter(({ text }) => text === "Received the answer.").length;
  const waitForReplies = async (count: number) => {
    const deadline = Date.now() + 5_000;
    while (replies() < count) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the fixture reply.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await runtime.command({ type: "send", agentId: taskId, text: "/release-notes v2.1" });
  await waitForReplies(1);
  assert.deepEqual(listCalls(), [{ cwds: [tmpdir()] }, { cwds: [runtime.snapshot().project.path] }],
    "a repository task lists skills from its repository");
  await runtime.command({ type: "send", agentId: taskId, text: "Use /release-notes later" });
  await waitForReplies(2);
  await runtime.skills([projectId, projectId]);
  assert.equal(listCalls().length, 2, "duplicate repository IDs share the cached list, and plain messages list nothing");
  const inputs = trace().filter(({ method }) => method === "turn/start").map(({ params }) => params.input);
  assert.deepEqual(inputs[0], [
    { type: "text", text: "/release-notes v2.1", text_elements: [] },
    { type: "skill", name: "release-notes", path: "/skills/release-notes/SKILL.md" },
  ]);
  assert.deepEqual(inputs[1], [{ type: "text", text: "Use /release-notes later", text_elements: [] }]);
});

test("Claude skills come from a prompt-less Claude Code query and hide session commands", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-claude-skills-"));
  const queries: { options: any; closed: () => boolean }[] = [];
  const query = ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: any }) => {
    let closed = false;
    void (async () => { for await (const _ of prompt) assert.fail("listing skills must not send a prompt"); closed = true; })();
    queries.push({ options, closed: () => closed });
    return { supportedCommands: async () => [
      { name: "echo-test", description: "Project skill (project)", argumentHint: "" },
      { name: "compact", description: "Summarize the conversation", argumentHint: "<instructions>", builtin: true },
      { name: "clear", description: "Start a new session", argumentHint: "", builtin: true },
      { name: "model", description: "Set the model", argumentHint: "<model>", builtin: true },
      { name: "__remote-workflow", description: "Internal", argumentHint: "", builtin: true },
    ] };
  };
  const store = workspaceStore(root, join(root, "state"), "engine:claude");
  const runtime = new WorkspaceRuntime({ cwd: root, engine: "claude", store,
    createServer: () => new ClaudeAppServer(store.claudeJournalPath, query as any) });
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  assert.deepEqual(await runtime.skills(), [
    { name: "echo-test", description: "Project skill (project)" },
    { name: "compact", description: "Summarize the conversation", argumentHint: "<instructions>" },
  ]);
  await runtime.skills();
  assert.equal(queries.length, 1, "the list is cached");
  const [{ options, closed }] = queries;
  assert.equal(options.cwd, tmpdir());
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.equal(options.abortController.signal.aborted, true, "the listing process is stopped");
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed(), true, "the prompt stream ends");
});

test("the demo workspace offers sample skills", async () => {
  const runtime = new WorkspaceRuntime({ cwd: process.cwd(), demo: true });
  assert.ok((await runtime.skills()).some(({ name }) => name === "code-review"));
  await runtime.close();
});

test("skill lists are cached per repository set, in any order, and the cache is bounded", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-skill-scopes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = Array.from({ length: 20 }, (_, index) => ({ id: `repo-${String(index).padStart(2, "0")}`, path: join(root, `repo-${index}`) }));
  const calls: string[][] = [];
  const server = {
    call: async (method: string, params: any) => {
      if (method === "skills/list") calls.push(params.cwds);
      return { data: [] };
    },
    notify() {}, reply() {}, reject() {}, close: async () => {},
  };
  for (const engine of ["codex", "claude"] as const) {
    calls.length = 0;
    const runtime = new WorkspaceRuntime({ cwd: root, projects, engine }) as any;
    runtime.server = server;
    await runtime.skills(["repo-02", "repo-01"]);
    await runtime.skills(["repo-01", "repo-02", "repo-01"]);
    if (engine === "codex") {
      assert.deepEqual(calls, [[projects[1].path, projects[2].path]], "Codex lists every repository, keyed by the sorted set");
    } else {
      // Claude Code loads project skills only from its working directory, the task's first repository.
      assert.deepEqual(calls, [[projects[2].path], [projects[1].path]]);
    }
    for (const { id } of projects) await runtime.skills([id]);
    assert.equal(runtime.skillCatalogs.size, 16);
    await runtime.close();
  }
});
