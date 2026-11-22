# Technical design

Orchestra runs a local TypeScript server and a React browser UI. The server owns configured repositories, session identities, queues, isolated worktrees, pinned delivery revisions, and persistent task data. Codex App Server executes turns and owns its native child threads.

## Sessions

A direct task maps to one addressable Codex thread. Use read-only access for planning and ordinary follow-ups. An explicit implementation turn supplies isolated writable worktrees for the selected repositories. Native child records track provider thread IDs, parent relationships, activity, replies, and observed usage. Child chats are inspected by ID and the parent coordinates their work.

Product questions bind a pending decision to its task and message. An accepted answer is persisted with the continuation. Interrupted and uncertain provider turns are reconciled without blindly resending input.

## Delivery

An implementation result must record passing checks against the same candidate contents Orchestra pins. Capture each repository separately in a clean detached worktree. The original checkout and its branch stay untouched until the user integrates the result.

## Local state

Persist direct task history and enough queue and thread information to resume after restart. Track model settings and usage separately from workspace state. Browser preferences hold drafts and camera positions. Isolate live workspaces by their repository identity and Codex provider.
