import assert from "node:assert/strict";
import { test } from "node:test";
import { filterAgentsByProject, normalizeProjectFilter, projectFilterLabel, toggleProject, workspaceFilter } from "../src/workspace-project-filter.ts";

const projects = ["api", "web", "docs"];
const agents = [
  { id: "api-task", directTask: { projectIds: ["api"] }, projectId: "api" },
  { id: "api-child", parentId: "api-task", projectId: "api" },
  { id: "general", directTask: { projectIds: [] } },
  { id: "general-child", parentId: "general", projectId: "web" },
  { id: "general-grandchild", parentId: "general-child" },
  { id: "multi", directTask: { projectIds: ["web", "docs"] }, projectId: "web" },
  { id: "orphan-child", parentId: "archived-root", projectId: "docs" },
];
const ids = (list: { id: string }[]) => list.map(({ id }) => id);

test("the workspace filter shows every task", () => {
  assert.deepEqual(ids(filterAgentsByProject(agents, workspaceFilter)), ids(agents));
});

test("a task shows when it or any subagent works in a checked project, with its whole subtree", () => {
  assert.deepEqual(ids(filterAgentsByProject(agents, { mode: "projects", projectIds: ["api"] })), ["api-task", "api-child"]);
  assert.deepEqual(ids(filterAgentsByProject(agents, { mode: "projects", projectIds: ["web"] })),
    ["general", "general-child", "general-grandchild", "multi"], "a subagent's project brings in its main task");
  assert.deepEqual(ids(filterAgentsByProject(agents, { mode: "projects", projectIds: ["docs"] })), ["multi", "orphan-child"],
    "a subagent whose parent is not on the map counts as a main task");
  assert.deepEqual(ids(filterAgentsByProject(agents, { mode: "projects", projectIds: [] })), []);
});

test("saved filters drop unknown projects and treat every project as the workspace", () => {
  assert.deepEqual(normalizeProjectFilter(null, projects), workspaceFilter);
  assert.deepEqual(normalizeProjectFilter({ mode: "projects", projectIds: ["web", "gone"] }, projects), { mode: "projects", projectIds: ["web"] });
  assert.deepEqual(normalizeProjectFilter({ mode: "projects", projectIds: ["docs", "api", "web"] }, projects), workspaceFilter);
  assert.deepEqual(normalizeProjectFilter({ mode: "projects", projectIds: "web" }, projects), workspaceFilter);
});

test("toggling projects leaves and rejoins the workspace view", () => {
  const withoutWeb = toggleProject(workspaceFilter, "web", false, projects);
  assert.deepEqual(withoutWeb, { mode: "projects", projectIds: ["api", "docs"] });
  assert.deepEqual(toggleProject(withoutWeb, "web", true, projects), workspaceFilter);
  assert.equal(projectFilterLabel(workspaceFilter, "My workspace"), "My workspace");
  assert.equal(projectFilterLabel(withoutWeb, "My workspace"), "2 projects");
  assert.equal(projectFilterLabel({ mode: "projects", projectIds: ["api"] }, "My workspace"), "api");
  assert.equal(projectFilterLabel({ mode: "projects", projectIds: [] }, "My workspace"), "No projects");
});
