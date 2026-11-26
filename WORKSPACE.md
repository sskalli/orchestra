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

Claude tasks load your Claude Code settings and the repository's `CLAUDE.md`, as `claude` does in a terminal. Planning turns ask before edits and before commands that aren't read-only. During an approved implementation turn, Claude edits the approved worktrees directly and runs sandboxed commands without asking. Anything outside those destinations still comes to the chat for approval. Claude subagents appear as children of their task on the map. A task that starts background subagents keeps its turn open until they finish: it can end its reply, ask you a product question, and take your answers and messages right away while the subagents keep working. The composer shows how many subagents it is waiting for. Stopping the turn stops its subagents too. If Orchestra stops during a Claude turn, that turn is reported as interrupted after restart, because Claude Code runs as a child of the Orchestra server.

## Task flow

- Use **+** to open a new-session composer. Write the first message, add an optional name, and select any repositories the task needs before starting the session. Leave repository scope empty for a general chat.
- Open the floating **Inbox** from the map’s top-left corner. **Open conversation** jumps to the relevant message. Selecting a task opens a floating conversation at the last width you used (65% by default) and frames its group in the space beside it. Drag the conversation’s left edge to resize it on desktop. Drag the Inbox’s right edge, bottom edge, or bottom-right corner to adjust its size. The windows leave a gap when both are open. Closing the chat keeps the current map view.
- Native Codex and Claude subagents orbit their parent. Their transcripts are available for inspection, and you give further instructions in the parent chat.
- Product questions keep their source message and pending status across restart. Answer in the task chat and the agent can link your reply to the question. Unrelated replies leave it pending. The Inbox retains activity across reloads. **Clear** removes its history and keeps pending questions. Archiving or deleting a task removes its entries and its subagents’ entries from the Inbox.
- A repository-backed task starts read-only. Describe the change in chat as usual. When the agent is ready to edit, it asks for permission to edit in the conversation. Click **Allow edits** to authorize one implementation turn in isolated worktrees for the selected repositories. Answer pending product questions in the chat before allowing edits. The agent can ask for permission again to revise a candidate. Orchestra requires passing verification before it pins a delivery revision. Review and merge isolated changes manually.
- To edit the original folder, ask the agent to edit the configured checkout for the named repository. To use a specific linked worktree, ask for its absolute path and optionally a new branch name. Choose an unused path outside configured repositories whose parent already exists. The approval card lists the write mode for each selected repository. Direct edits apply in place, including when the checkout already has local changes, and do not produce a delivery snapshot. Orchestra reserves that checkout across workspace servers until the turn and its subagents stop. If a server stops unexpectedly, restart its workspace so Orchestra can confirm the provider is idle and release the reservation. One server at a time can open the same saved workspace. Other selected repositories still use automatic worktrees unless the request specifies their own write modes.
- Any task turn can ask for access the sandbox does not grant. For example, you can ask for a change at a path outside the selected repositories, or a check might need local access. The approval card shows the command, files, or paths and the working directory. **Approve once** allows that single request. **Allow for this task** appears when Codex offers it and covers similar requests until Orchestra restarts. **Decline** refuses the request. When Codex offers no plain decline, the card says that declining stops the turn so you can reply with other instructions. Approved commands run with your local account's access. Access approved outside **Allow edits** acts in place, including on a configured checkout, and produces no isolated worktree, verification, or delivery snapshot. Orchestra declines requests it cannot show in full and requests from subagents. The agent still needs to record passing verification to pin a candidate.

## UI review scenario

Run `npm run workspace` without arguments to open the simulated scenario. It starts without a Codex connection and uses sample messages and delivery details. The search investigation and its child stay marked as running for layout review. Use **Release notes** or **Weeknight dinner** to try archiving and restoring. Restart the server to reset the tasks, and use a fresh browser profile or port to start with default layout and drafts.

- Open **Release notes** from the Inbox to locate the pending question, then inspect the reviewer's read-only transcript on the map.
- Open **Dashboard empty state** and expand the delivery snapshots to inspect the candidate and checks.
- Compare **Investigate slow search** and its running child with the completed **Weeknight dinner** task. Type an unsent draft, switch chats, and return to verify the draft is still there.
- Open **Review CSV export** from its **Failed** Inbox entry or map badge to inspect the error in the chat.
- Collapse and expand the Inbox, resize both docks, and reload to check that the layout and draft are retained.

## Recovery and usage

Closing the browser tab leaves the local server running. On restart, Orchestra restores tasks, their native children, and queued messages. Interrupted or uncertain work may require review before resuming. An interrupted implementation cannot publish an unverified candidate. Archive a task from its conversation and restore it through **Archived**. Deleting an archived conversation does not delete its Git worktree.

Existing direct tasks and their native descendants are imported into a separate local task file on first launch. The previous workspace file remains available as a backup. Existing usage for those tasks carries forward into the new usage file.

The usage menu reports observed Codex input, cached input, output, and coverage. It can export usage without prompts or credentials. Account quotas and billing are separate.
