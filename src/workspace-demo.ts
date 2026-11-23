import type { WorkspaceAgent } from "./workspace-runtime.ts";

type DemoTask = Pick<WorkspaceAgent, "id" | "name" | "messages"> &
  Partial<Pick<WorkspaceAgent, "parentId" | "nativeChild" | "directTask" | "duty" | "status" | "integration">>;

export function demoTasks(projectId: string): DemoTask[] {
  const delivery = {
    id: "demo-delivery",
    path: "/demo/worktrees/dashboard",
    base: "demo-base",
    fingerprint: "demo-candidate",
    sources: [],
    members: [{
      projectId,
      path: "/demo/worktrees/dashboard",
      base: "demo-base",
      fingerprint: "demo-candidate",
      revision: "demo-revision",
    }],
    validationEvidence: {
      submissionId: "demo-delivery",
      candidateFingerprint: "demo-candidate",
      outcome: "passed" as const,
      summary: "Dashboard smoke tests passed (simulated).",
      recordedAt: 0,
    },
  };

  return [
    {
      id: "demo-release",
      name: "Release notes",
      status: "done",
      directTask: { projectIds: [], phase: "planning" },
      messages: [
        { id: "demo-release-request", role: "user", text: "Draft a release note for the workspace updates." },
        { id: "demo-release-draft", role: "assistant", text: "The draft covers task sessions, native subagents, and the workspace inbox." },
        { id: "demo-release-question", role: "system", kind: "action", text: "Should the release note be terse or detailed?",
          productQuestion: { status: "pending" } },
      ],
    },
    {
      id: "demo-review",
      name: "Check the draft",
      parentId: "demo-release",
      nativeChild: true,
      duty: "reviewer",
      status: "done",
      messages: [{ id: "demo-review-report", role: "assistant", text: "The draft covers all three workspace changes." }],
    },
    {
      id: "demo-delivery",
      name: "Dashboard empty state",
      duty: "coder",
      status: "awaiting-confirmation",
      directTask: { projectIds: [], phase: "ready-for-review" },
      integration: delivery,
      messages: [{ id: "demo-delivery-report", role: "assistant", text: "The empty state is ready for review. Open the delivery details to see the simulated snapshot and checks." }],
    },
    {
      id: "demo-dashboard-lead",
      name: "Coordinate dashboard checks",
      parentId: "demo-delivery",
      nativeChild: true,
      duty: "lead",
      status: "done",
      messages: [{ id: "demo-dashboard-lead-report", role: "assistant", text: "Design and smoke checks are complete." }],
    },
    {
      id: "demo-dashboard-tester",
      name: "Run dashboard smoke tests",
      parentId: "demo-dashboard-lead",
      nativeChild: true,
      duty: "tester",
      status: "done",
      messages: [{ id: "demo-dashboard-tester-report", role: "assistant", text: "The empty state renders and the retry action works." }],
    },
    {
      id: "demo-dashboard-designer",
      name: "Review the empty state",
      parentId: "demo-delivery",
      nativeChild: true,
      duty: "designer",
      status: "done",
      messages: [{ id: "demo-dashboard-designer-report", role: "assistant", text: "The heading explains what happened and the next action is visible." }],
    },
    {
      id: "demo-dashboard-pm",
      name: "Check acceptance criteria",
      parentId: "demo-delivery",
      nativeChild: true,
      duty: "pm",
      status: "done",
      messages: [{ id: "demo-dashboard-pm-report", role: "assistant", text: "The empty and error states meet the agreed criteria." }],
    },
    {
      id: "demo-investigation",
      name: "Investigate slow search",
      status: "working",
      directTask: { projectIds: [], phase: "planning" },
      messages: [{ id: "demo-investigation-request", role: "user", text: "Find out why filtering a large list feels slow." }],
    },
    {
      id: "demo-search-trace",
      name: "Trace filter requests",
      parentId: "demo-investigation",
      nativeChild: true,
      duty: "analyser",
      status: "working",
      messages: [{ id: "demo-search-trace-progress", role: "assistant", text: "I’m comparing browser and service timings." }],
    },
    {
      id: "demo-search-repro",
      name: "Reproduce and document the slowdown",
      parentId: "demo-investigation",
      nativeChild: true,
      status: "done",
      messages: [{ id: "demo-search-repro-report", role: "assistant", text: "I captured a reproduction and noted the slowest interaction." }],
    },
    {
      id: "demo-export",
      name: "Review CSV export",
      status: "error",
      directTask: { projectIds: [], phase: "planning" },
      messages: [
        { id: "demo-export-request", role: "user", text: "Review the CSV export for edge cases.", state: "failed" },
        { id: "demo-export-error", role: "system", kind: "error", text: "The session timed out while waiting for a response. Send a follow-up to retry." },
      ],
    },
    {
      id: "demo-recipe",
      name: "Weeknight dinner",
      status: "done",
      directTask: { projectIds: [], phase: "planning" },
      messages: [{ id: "demo-recipe-result", role: "assistant", text: [
          "## Lemon chickpeas with roasted vegetables",
          "A quick dinner with a crisp finish and a bright lemon dressing.",
          "1. Roast the vegetables at **220°C** until the edges brown.",
          "2. Toss the chickpeas with lemon juice, olive oil, and a pinch of salt.",
          "3. Serve with yogurt or a spoonful of tahini.",
          "> Add the dressing just before serving to keep the vegetables crisp.",
        ].join("\n\n") }],
    },
  ];
}
