# Technical design

Orchestra runs a local TypeScript server and a React browser UI. The server owns configured repositories, session identities, queues, isolated worktrees, pinned delivery revisions, and persistent task data. Codex App Server executes turns and owns its native child threads.

## Sessions

A direct task maps to one addressable Codex thread. Use read-only access for planning and ordinary follow-ups. An explicit implementation turn supplies per-repository writable roots. Isolated linked worktrees are the default. The immutable request can instead name a configured checkout or an exact path and optional new branch for a linked worktree. Orchestra creates linked worktrees and scopes the Codex turn to the approved roots. Native child records track provider thread IDs, parent relationships, activity, replies, and observed usage. Child chats are inspected by ID and the parent coordinates their work.

Every task turn uses on-request approvals, so the agent can ask for access the sandbox does not grant. Orchestra shows each native Codex request in the task chat: a command outside the sandbox, a file change outside the writable roots, or a permission request for extra paths or network. The card shows the exact command, files, paths, and working directory. It offers only the choices Codex lists for that request. If Codex offers cancel but not decline, the card warns that declining stops the turn. Each card is bound to its live provider request, and Orchestra relays exactly one decision. A pending approval expires when the provider resolves the request, the turn ends, or Orchestra restarts. Orchestra declines a request it cannot display in full, such as unlisted files or hidden characters. It also declines requests from native children, so the parent task asks instead. Access granted outside an implementation turn applies in place and bypasses isolated delivery. Approving any request invalidates an earlier check result for that turn.

Product questions bind a pending decision to its task and message. An accepted answer is persisted with the continuation. Interrupted and uncertain provider turns are reconciled without blindly resending input.

## Delivery

An implementation result must record passing checks against the same candidate contents Orchestra pins. Capture each repository separately in a clean detached worktree. For isolated edits, the original checkout stays untouched until the user integrates the result. Direct checkout edits appear in place and are verified without pinning a separate delivery revision.

## Local state

Persist direct task history and enough queue and thread information to resume after restart. Track model settings and usage separately from workspace state. Browser preferences hold drafts and camera positions. Isolate live workspaces by their repository identity and Codex provider.
