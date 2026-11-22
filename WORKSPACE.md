# Orchestra workspace

Use Node.js 22.18 or newer. Run `npm ci` before starting the workspace. The local server listens on port 4317 by default.

## Launch modes

```bash
npm run workspace
npm run workspace -- --live /path/to/git/project
npm run workspace -- --project app=/path/to/app --project api=/path/to/api
```

The first command is a simulated demo. Live sessions use a local Codex App Server. Sign in through ChatGPT before launching. Worktrees require a Git repository with a commit.

All configured repos share one map and inbox. Define each repository ID once. The workspace identity is based on resolved paths and IDs. Argument order does not affect it. A single-repository workspace keeps its identity if you change only its repository ID.

| Setting | Purpose |
| --- | --- |
| `ORCHESTRA_PORT` | Set the local HTTP port. |
| `ORCHESTRA_STATE_DIR` | Override where live workspace state is stored. |
| `CODEX_BIN` | Set the Codex executable path. |
| `CODEX_MODEL` | Override Codex model selection for new tasks. |

For a separately configured Codex provider, define it in Codex's configuration and pass `--provider ID` alongside `--live` or `--project`. Use a dedicated environment variable for that provider's credentials. Orchestra strips `OPENAI_API_KEY` and `CODEX_API_KEY` from the App Server process. Each provider has separate saved sessions.

## Task flow

- Use **+** to start a chat. Select any configured repos the task needs. You can also start a general session with no repository.
- The left inbox shows task status and details. **Open conversation** opens the relevant chat. The right panel shows the selected conversation.
- Native Codex children orbit their parent. Their transcripts are available for inspection, and you give further instructions in the parent chat.
- Product questions keep their source message and pending status across restart. Answer in the task chat and the agent can link your reply to the question. Unrelated replies leave it pending. Use **Answer question** to target a question explicitly.
- A repository-backed task starts read-only. **Start implementation** lets that same session write only in isolated worktrees of its selected repos. **Revise candidate** authorizes another implementation turn after discussion. Orchestra requires passing coder-reported verification for the submitted contents before it pins a delivery revision. Review and merge changes manually.

## Recovery and usage

Closing the browser tab leaves the local server running. On restart, Orchestra restores tasks, their native children, and queued messages. Interrupted or uncertain work may require review before resuming. An interrupted implementation cannot publish an unverified candidate. Archive a task from its conversation and restore it through **Archived**. Deleting an archived conversation does not delete its Git worktree.

Existing direct tasks and their native descendants are imported into a separate local task file on first launch. The previous workspace file remains available as a backup. Existing usage for those tasks carries forward into the new usage file.

The usage menu reports observed Codex input, cached input, output, and coverage. It can export usage without prompts or credentials. Account quotas and billing are separate.
