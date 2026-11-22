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
      status: "awaiting-confirmation",
      directTask: { projectIds: [], phase: "ready-for-review" },
      integration: delivery,
      messages: [{ id: "demo-delivery-report", role: "assistant", text: "The empty state is ready for review. Open the delivery details to see the simulated snapshot and checks." }],
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
      id: "demo-recipe",
      name: "Weeknight dinner",
      status: "done",
      directTask: { projectIds: [], phase: "planning" },
      messages: [{ id: "demo-recipe-result", role: "assistant", text: "Try lemon chickpeas with roasted vegetables." }],
    },
  ];
}
