# Working on Orchestra

Read `PRODUCT.md`, `TECHNICAL.md`, and `ROADMAP.md` before implementing. Use them to understand the product intent, technical constraints, and current priorities.

Verify provider behavior against the current direct-task workflow. When behavior is unclear, unsupported, or inconsistent with the expected result, surface it with concrete reproduction steps rather than guessing.

## Implementation

Implement the smallest change that satisfies the requested outcome. Prefer clear, maintainable code and follow the existing project conventions.

Before making a materially different product or architectural decision, explain the trade-off and ask for confirmation.

## Validation

Run the relevant checks for the changed area. Verify the integrated result, not only the isolated change.

If a verification failure is recoverable, fix it. If it reveals a broader issue or an unsupported provider behavior, report it clearly with reproduction steps.

## Delegation

Use subagents when they genuinely help: for bounded independent work, focused review, testing a real scenario, or UX review of workspace interactions.

Keep delegated work small and specific. Give each subagent a clear output, scope, and file ownership. Do not delegate by default; choose the approach that best fits the task.

## Git

Use a separate worktree for independent feature implementations when available. Ask before merging into the user’s project branch.