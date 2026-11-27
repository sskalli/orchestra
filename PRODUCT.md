# Orchestra product spec

Orchestra is a local workspace for working with multiple Codex or Claude tasks. Each launch uses one engine, and a user can run both side by side. Group related repos in a workspace. Start independent sessions from the map and use the inbox to find the tasks that need your attention.

## Workspace

The left dock shows task activity and opens the source conversation. The right dock shows the selected chat. Preserve drafts by task and keep the viewed area anchored as the docks resize or collapse.

Top-level tasks have large nodes. Native children appear on successive rings as smaller nodes. Use role color when the provider identifies a role, and keep node size tied to hierarchy. Hovering or selecting nodes reveals relevant links. Animate supported parent-child interactions on the map.

## Task sessions

A session can handle a general conversation, a read-only investigation, or work across one or more repositories. Keep planning, user decisions, delivery, and follow-up in the same task chat. The session can delegate through its engine's subagents and report results from its children. Child chats are available for inspection.

A task can read and write its selected repositories from the start. The agent applies a worktree workflow itself: a linked worktree and branch per change, with commits there and no pull requests. Show each commit, new branch, push, and published branch in the task chat. Access outside the selected repositories needs the user's approval, and one approval can cover a folder for the rest of the task instead of each command.

Persist open questions and task history. Make provider failures and interrupted work visible and allow the user to recover without losing the plan or transcript.
