import type { WorkspaceAgent } from "./workspace-runtime.ts";

type DemoTask = Pick<WorkspaceAgent, "id" | "name" | "messages"> &
  Partial<Pick<WorkspaceAgent, "parentId" | "nativeChild" | "directTask" | "duty" | "status">>;

export function demoTasks(projectId: string): DemoTask[] {
  const tasks: DemoTask[] = [
    {
      id: "demo-release",
      name: "Release notes",
      status: "done",
      directTask: { projectIds: [] },
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
      status: "done",
      directTask: { projectIds: [] },
      messages: [
        { id: "demo-delivery-report", role: "assistant", text: "The empty state is done on its own branch and committed." },
        { id: "demo-delivery-branch", role: "system", kind: "git", text: "Created branch `dashboard-empty-state` in demo at `1a2b3c4` Add dashboard empty state" },
      ],
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
      directTask: { projectIds: [] },
      messages: [
        { id: "demo-investigation-request", role: "user", text: "Find out why filtering a large list feels slow. Save the profile under /demo/profiles." },
        { id: "demo-investigation-access", role: "system", kind: "action", text: "Permission requested to run a command outside the sandbox.",
          commandApproval: { status: "pending", kind: "command", command: "npm run profile -- --out /demo/profiles/search.json",
            cwd: "/demo/app", reason: "Write the search profile to the folder you named.", writePaths: ["/demo/profiles"],
            choices: ["approve", "approveForSession", "decline"] } },
      ],
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
      directTask: { projectIds: [] },
      messages: [
        { id: "demo-export-request", role: "user", text: "Review the CSV export for edge cases.", state: "failed" },
        { id: "demo-export-error", role: "system", kind: "error", text: "The session timed out while waiting for a response. Send a follow-up to retry." },
      ],
    },
    {
      id: "demo-recipe",
      name: "Weeknight dinner",
      status: "done",
      directTask: { projectIds: [] },
      messages: [
        { id: "demo-recipe-request", role: "user", text: "Give me a quick dinner for two with chickpeas, plus ideas for leftovers." },
        { id: "demo-recipe-result", role: "assistant", text: [
          "## Lemon chickpeas with roasted vegetables",
          "This makes dinner for two in about **30 minutes**. The vegetables get browned in the oven while you mix a lemon dressing and make a quick yogurt sauce. If you have leftover rice or couscous, warm it up to make the bowls more substantial.",
          "### What you’ll need",
          "- **For the tray:** one can of chickpeas, one small cauliflower, one red onion, two tablespoons of olive oil, and a teaspoon of smoked paprika.",
          "- **For the dressing:** the juice and zest of a lemon, one tablespoon of olive oil, and a pinch of salt.",
          "- **To serve:** plain yogurt or tahini, a handful of parsley, and warm flatbread.",
          "### How to make it",
          "1. Heat the oven to **220°C**. Drain the chickpeas and pat them dry. Cut the cauliflower into bite-sized florets and the onion into wedges.",
          "2. Toss the chickpeas and vegetables with olive oil, paprika, and salt. Spread everything in a single layer on a large tray. Use two trays if the pieces touch.",
          "3. Roast for 22–25 minutes, turning the vegetables halfway through. The cauliflower is ready when the edges are browned and a fork goes through the stems easily.",
          "4. Whisk the lemon juice, zest, oil, and salt while the tray is in the oven. Thin the yogurt or tahini with a spoonful of water and add a little lemon if it tastes flat.",
          "5. Divide the vegetables and chickpeas between bowls. Spoon over the dressing and finish with the sauce and chopped parsley. Serve with warm flatbread.",
          "> Add the dressing just before serving to keep the browned edges crisp. If you’re saving a portion for tomorrow, store the sauce separately.",
          "### Make it with what you have",
          "Broccoli or Brussels sprouts can take the place of the cauliflower. If you use zucchini, add it for the last 12 minutes so it keeps its shape. A spoonful of harissa in the dressing adds heat, and chopped mint works well in place of parsley.",
          "### Lunch tomorrow",
          "Warm the chickpeas and vegetables in a dry pan, then tuck them into a wrap with the leftover sauce and a handful of shredded cabbage. For a cold lunch, toss them with cooked grains and add the dressing when you’re ready to eat.",
        ].join("\n\n") },
      ],
    },
  ];
  const now = Date.now();
  return tasks.map((task, taskIndex) => ({
    ...task,
    messages: task.messages.map((message, messageIndex) => ({
      ...message,
      createdAt: now - (tasks.length - taskIndex) * 5 * 60_000 - (task.messages.length - messageIndex - 1) * 30_000,
    })),
  }));
}
