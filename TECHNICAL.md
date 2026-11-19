# Technical design

This is the target architecture. The implemented browser workspace and current provider limitations are documented in [WORKSPACE.md](WORKSPACE.md), with milestone status in [ROADMAP.md](ROADMAP.md).

Use TypeScript. A local Node runtime owns the Codex App Server process, project state, and worktrees. A React client renders the workspace and communicates with the runtime through a local command and event interface. Choose desktop packaging when implementing window close and explicit quit. The runtime should survive closing its window.

Orchestra owns team goals, agent relationships, squads, worktree assignments, and queue state. Codex owns execution and conversation threads. Start each visible agent as an addressable session so its chat can receive direct user messages. Give the coordinator and leads app-owned tools for delegation. Validate the tool registration and execution path on the installed App Server before locking in the protocol design. Preserve identities for project, team, agent, provider thread, and turn separately.

Separate hierarchy from acceptance authority: reviewer and tester sessions can be children of their target coder while the lead remains the acceptance owner. Bind each result to the coder submission and candidate snapshot assigned when the check starts. Multiple coders use independent worktrees. Combined delivery uses a separate integration candidate with recorded source submissions and an independent integration-test result; it never merges into the project branch automatically. Choose delegation based on separable scope and verification value, not a fixed agent count.

Use local Codex App Server and provider-managed ChatGPT sign-in. Use the signed-in account's Codex allowance and surface usage limits. Route user input, streamed messages, approvals and interrupts through App Server. Use rollout parsing only for a demonstrated gap. See the [App Server protocol](https://learn.chatgpt.com/docs/app-server).

Persist enough app state to reopen sessions and recover drafts, pending messages, and camera state. Reconcile interrupted or uncertain turn state with the provider on reconnect. Avoid retrying a submission blindly after an ambiguous disconnect. Keep app queue state distinct from provider turn state and task completion.

Use Codex for the first release. For Claude, validate the local Claude Code integration, subscription sign-in eligibility, streaming, approvals, and direct follow-ups. Design the provider boundary from both implementations once validated.
