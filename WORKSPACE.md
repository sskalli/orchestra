# Orchestra workspace

Use Node.js 22.18 or newer. Run `npm ci`, then `npm link` to install the `orchestra` command.

## Launch modes

```bash
orchestra codex  /path/to/git/project
orchestra claude /path/to/git/project
orchestra codex:ID --project app=/path/to/app --project api=/path/to/api
orchestra demo
```

`orchestra codex` uses a local Codex App Server and your ChatGPT sign-in. `orchestra claude` runs Claude Code sessions through the Claude Agent SDK with the sign-in from `claude auth login`, so usage counts against your Claude plan. Orchestra removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from Claude sessions so they don't switch to API billing. Before starting, the launcher checks the sign-in and offers to run the login command. Worktrees require a Git repository with a commit. The demo is a simulated workspace.

Codex starts on port 4317 and Claude on 4327. If a port is taken, Orchestra uses the next free one and prints the address. Browser layout and drafts are kept per address, so a workspace that moves to another port starts with a default layout. The underlying server options still work: `npm run workspace -- --engine claude --live /path`, `--provider ID`, and `--project ID=/path`.

All configured repos share one map and Inbox. Define each repository ID once. The workspace identity is based on resolved paths and IDs. Argument order does not affect it. A single-repository workspace keeps its identity if you change only its repository ID. Codex, each custom Codex provider, and Claude keep separate saved tasks for the same repositories.

| Setting | Purpose |
| --- | --- |
| `ORCHESTRA_PORT` | Use this exact local HTTP port. |
| `ORCHESTRA_STATE_DIR` | Override where live workspace state is stored. |
| `CODEX_BIN` | Set the Codex executable path. By default Orchestra looks on `PATH`, then in the ChatGPT desktop app. |
| `CODEX_MODEL` | Override Codex model selection for new tasks. |
| `CLAUDE_BIN` | Run a specific Claude Code executable instead of the one bundled with the Agent SDK. |
| `CLAUDE_MODEL` | Override Claude model selection for new tasks, for example `claude-opus-5-5`. |

For a separately configured Codex provider, define it in Codex's configuration and launch with `orchestra codex:ID`. Use a dedicated environment variable for that provider's credentials. Orchestra strips `OPENAI_API_KEY` and `CODEX_API_KEY` from the App Server process.

### Claude sessions

Claude tasks load your Claude Code settings and the repository's `CLAUDE.md`, as `claude` does in a terminal. In a repository task, Claude edits the selected repositories directly and runs sandboxed commands without asking. In a general chat it asks before edits and before commands that aren't read-only. Anything outside the allowed folders still comes to the chat for approval. Claude subagents appear as children of their task on the map. A task that starts background subagents keeps its turn open until they finish: it can end its reply, ask you a product question, and take your answers and messages right away while the subagents keep working. The composer shows how many subagents it is waiting for. Stopping the turn stops its subagents too. If Orchestra stops during a Claude turn, that turn is reported as interrupted after restart, because Claude Code runs as a child of the Orchestra server.

## Task flow

- Use **+** to open a new-session composer. Write the first message, add an optional name, and select any repositories the task needs before starting the session. Leave repository scope empty for a general chat.
- Open the floating **Inbox** from the map’s top-left corner. **Open conversation** jumps to the relevant message. Selecting a task opens a floating conversation at the last width you used (65% by default) and frames its group in the space beside it. Drag the conversation’s left edge to resize it on desktop. Drag the Inbox’s right edge, bottom edge, or bottom-right corner to adjust its size. The windows leave a gap when both are open. Closing the chat keeps the current map view.
- Native Codex and Claude subagents orbit their parent. Their transcripts are available for inspection, and you give further instructions in the parent chat.
- Product questions keep their source message and pending status across restart. Answer in the task chat and the agent can link your reply to the question. Unrelated replies leave it pending. The Inbox retains activity across reloads. Its dot and the count in the tab title show only notifications you have not seen: opening the Inbox, or the task's chat, while the page is visible marks them seen. **Clear** removes its history and keeps pending questions. Archiving or deleting a task removes its entries and its subagents’ entries from the Inbox.
- A repository-backed task can read and write its selected repositories from the first turn, including their Git data. Ask for a change in chat as usual. The agent works in a linked worktree under `<repository>/.worktrees/` on a new branch, commits there, and leaves the main checkout as you left it unless you ask otherwise. It does not open pull requests, and it pushes or publishes a branch only when you ask. Orchestra posts a **Git** note in the chat for each new commit, new branch, push, or published branch the task made. A pull, fetch or reset is not reported. When two tasks work in the same repository at once, the second one gets a warning and is told to stay in its own worktree, and Git activity that could belong to either task is not shown in either. **Show changes** lists the local checkout, compared with its contents when the task started, and each worktree the task created.
- Network access stays off, so a push comes to the chat for approval. Anything outside the selected repositories also comes to the chat: the card shows the command, files, or paths and the working directory. **Approve once** allows that single request. **Allow for this task** appears when the provider offers it. It covers similar requests until Orchestra restarts. When the card lists folders under **Allow for this task**, later turns of the task can write them without asking again. Approving one file never grants your home folder or the filesystem root. **Decline** refuses the request. When Codex offers no plain decline, the card says that declining stops the turn so you can reply with other instructions. Approved commands run with your local account's access. Orchestra declines requests it cannot show in full and requests from subagents.
- Tasks saved by earlier versions keep their worktrees in the changes view. An old **Allow edits** request shows as a plain notice.
- A product question stays pending until the agent links your reply to it, which it can do even for a reply sent while it was working. Use **Mark resolved** on the question to clear it yourself.

## UI review scenario

Run `npm run workspace` without arguments to open the simulated scenario. It starts without a Codex connection and uses sample messages. The search investigation and its child stay marked as running for layout review. Use **Release notes** or **Weeknight dinner** to try archiving and restoring. Restart the server to reset the tasks, and use a fresh browser profile or port to start with default layout and drafts.

- Open **Release notes** from the Inbox to locate the pending question, then inspect the reviewer's read-only transcript on the map.
- Open **Dashboard empty state** to see a **Git** note.
- Compare **Investigate slow search** and its running child with the completed **Weeknight dinner** task. Type an unsent draft, switch chats, and return to verify the draft is still there.
- Open **Review CSV export** from its **Failed** Inbox entry or map badge to inspect the error in the chat.
- Collapse and expand the Inbox, resize both docks, and reload to check that the layout and draft are retained.

## Recovery and usage

Closing the browser tab leaves the local server running. On restart, Orchestra restores tasks, their native children, and queued messages. Interrupted or uncertain work may require review before resuming. Archive a task from its conversation and restore it through **Archived**. Deleting an archived conversation does not delete its Git worktree.

Existing direct tasks and their native descendants are imported into a separate local task file on first launch. The previous workspace file remains available as a backup. Existing usage for those tasks carries forward into the new usage file.

The usage menu reports observed Codex input, cached input, output, and coverage. It can export usage without prompts or credentials. Account quotas and billing are separate.
