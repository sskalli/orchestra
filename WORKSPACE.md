# Orchestra workspace

Use Node.js 22.18 or newer. Install dependencies and start the local workspace from the repository root.

```bash
npm ci
npm run workspace
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The demo has two teams and sample conversations. It uses no Codex allowance. Set `ORCHESTRA_PORT` to use another port.

To open a Git project with the Codex App Server, run this from a regular terminal with Codex signed in through ChatGPT. The executable defaults to `codex` on `PATH`; set `CODEX_BIN` if it is installed elsewhere.

```bash
npm run workspace -- --live /path/to/git/project
```

Alternatively, select a Codex custom provider configured in `~/.codex/config.toml`:

```toml
[model_providers.company]
name = "Company gateway"
base_url = "https://gateway.example.com/v1"
wire_api = "responses"
env_key = "COMPANY_API_KEY"
```

Export the API key using the configured `env_key` and select the provider ID at launch:

```bash
export COMPANY_API_KEY='your-api-key'
npm run workspace -- --live /path/to/git/project --provider company
```

The endpoint must support Codex's Responses API. Use a custom provider ID (not the built-in `openai` ID). Without `--provider`, Orchestra uses `openai` and retains its ChatGPT sign-in requirement. Each custom provider ID has separate saved sessions from the default provider and other custom providers; transcripts are not continued across provider modes. Use a dedicated environment variable for the custom provider. Orchestra removes `OPENAI_API_KEY` and `CODEX_API_KEY` before launching Codex.

### Multiple repositories

Configure a shared workspace at launch by repeating `--project` with a unique ID and Git repository path:

```bash
npm run workspace -- --project app=/path/to/app --project api=/path/to/api
```

The coordinator chat and team map are shared. Ask the coordinator to delegate to a specific project ID; when the target is ambiguous, clarify it in chat. The coordinator assigns one or more configured projects to a team and one project to a direct worker. In a multi-repository team, leads specify each coder’s repository. A coder’s checks inherit its repository and candidate worktree. The menu in the header lists project IDs and paths, and map and chat labels identify each agent's project.

Use `--provider company` alongside `--project` to use a configured custom provider.

A workspace with multiple repositories is identified by the full set of project IDs and resolved repository paths, independent of argument order. Changing an ID or path, or adding or removing a repository, opens a separate workspace. Restart the server to use the new project list.

A single-repository workspace is identified by its resolved repository path. Renaming the ID in `--project ID=path` keeps its conversations and assigns restored agents to the new ID. Drafts are preserved when you reopen the same browser URL. Both workspace types keep separate state for each Codex provider.

The live workspace opens a coordinator conversation, labeled **Computer** in the project chat. Discuss or refine a goal there, ask it to start a team, or ask for a standalone analysis. Each delegated agent has its own chat, queue, and status. The local Node process serves the browser workspace; closing the browser tab does not stop that process. Stop the server explicitly when finished.

## Claude Code mode

Start a Git project with Claude Code 2.1.248 or later.

```bash
claude --version
claude auth status
npm run workspace -- --claude /path/to/git/project
```

Configure credentials directly in Claude Code. Set `CLAUDE_BIN` to use a specific executable. See [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Anthropic's authentication guidance](https://code.claude.com/docs/en/legal-and-compliance).

- Claude mode provides a single coordinator chat with streamed replies. Project tools, code changes, Orchestra delegation, approval routing, and turn steering are unavailable. The CLI runs with restricted settings and an empty tool set. Claude Code still applies administrator-managed configuration and hooks where configured.
- Send another message during a turn to queue it. **Stop current turn** cancels the CLI run and pauses queued input. Choose **Resume queue** to continue. Failed turns also pause queued input. Restart after resolving a sign-in or usage-limit error.
- Orchestra stores Claude transcripts, CLI session IDs, and drafts separately from Codex. Follow-ups resume the CLI session after the first successful turn and require Claude Code session persistence. Leave `CLAUDE_CODE_SKIP_PROMPT_HISTORY` unset. A restart leaves interrupted turns flagged for review and queued messages paused. Orchestra does not reconcile incomplete Claude turns with CLI history or replay them automatically.
- To verify with a signed-in CLI, send a prompt asking Claude to remember a distinctive word, send a follow-up asking for the word, then repeat the follow-up after restarting the server. For cancellation, queue a second prompt during a long reply, stop the turn, and confirm the second prompt waits for **Resume queue**. Live authentication, usage, and reply streaming still require verification with an installed CLI.

## Workspace controls

- Select an agent to open its chat. Drag the edges of the project and agent panels to resize them; the handles also support arrow keys, Home and End. On narrow screens the project panel is below the map and its top edge changes its height.
- Drag the divider above a chat input to adjust its height. Composer sizes are saved separately for project and agent chats. Enter sends a message; Shift+Enter adds a line. Drafts are preserved per conversation.
- Agent roles have distinct node colors and halos. Hover or focus a node to see its own details and related links. Selecting a parent node also reveals descendant status icons (icon-only until the descendant itself is hovered/focused/selected). Supported agent-to-agent events animate a dot along a direct visible map link; the coordinator has no map node.
- New system messages are labeled and colored by category: error, action required, warning, notice, or success. Older saved messages without a category remain neutral. Your messages have a lighter background and messages are separated by lines.

## Workspace checks

### Archive and delete

Use the **⋯** menu in an agent chat header to **Archive team**, **Archive agent**, or **Delete permanently…**. Every action includes the selected agent's descendants; the pilot cannot be archived or deleted.

- Archive hides the subtree from the map, active status summaries, and new work routing. Chats, reports, queued input, and workspace references remain saved. Queued work stays paused.
- For running work, confirm **Stop and archive**. Orchestra waits for the provider to finish stopping before hiding agents. Failed cancellation or uncertain provider state leaves them visible with an explanation. Resolve uncertain work before retrying.
- **Archived (N)** on the map opens the archived list, including when the active map is empty. Open a conversation to read it, or choose **Restore**. Restoration includes the selected subtree and any archived ancestors it needs; it does not restart paused queues automatically.
- **Delete permanently…** confirms the affected agent count and removes their Orchestra records, conversations, and reports. Running or unresolved work blocks deletion. Project files, Git branches, worktrees, and provider-owned conversation history are not deleted. Historical updates in the pilot chat remain, with deleted conversation links disabled.

For manual verification, archive a nested agent, inspect its read-only chat in Archived, restore it, then archive a complete team. Reload and restart a live workspace to check persistence. Delete an archived team and confirm its conversations disappear while its project files and worktrees remain. Demo lifecycle changes last only for the running demo server.

- Select a worker, enter a draft, switch to another worker, then return to the first. The original draft should still be there.
- Tab to a node, use the arrow keys to move focus, and press Enter to open its conversation. Escape should close the conversation and restore focus to the node.
- Drag an empty part of the canvas with a conversation open. The camera should move and the conversation should remain open. Click empty space to clear selection.
- Scroll over a node to zoom around that point. Use a two-finger pinch on a touch display or **Fit all teams** to reframe the canvas. Opening or closing a dock should preserve visible node positions on screen.
- In demo mode, open the delivery lead's status and choose the sample approval or failed check. The corresponding conversation should focus the relevant event.
- Message the busy Canvas worker to see the queue. Use **Steer current turn** to send input to the active turn separately.
- With the local server running, reload the tab. The selected conversation, project dock, camera and per-agent drafts should return. The new event stream should show the running server's transcript, queue and pending approvals.

Browser preferences, including drafts, camera and panel sizes, are scoped to the workspace, mode, local server origin, and Codex provider ID. Live Orchestra servers save agent IDs, transcripts, queues and Codex thread IDs by workspace and provider under `${XDG_STATE_HOME:-~/.local/state}/orchestra`. The default single-repository `openai` provider retains its existing state location. Set `ORCHESTRA_STATE_DIR` to use a different directory. Run one live server per workspace, provider, and state directory. Demo runs use sample data.

After a live server restart, Orchestra requests the saved threads from Codex. If Codex confirms an interrupted turn completed, its reply is restored. Otherwise the interrupted message is flagged for review. Previous approval requests expire, and ordinary queued messages stay paused until you select **Resume queue**. Scheduled assignments waiting on a prerequisite are instead marked failed and must be scheduled again. An active or unresumable thread is generally shown as unavailable; when an older tool registration needs refreshing, Orchestra instead opens a new thread with the current tools. A coordinator thread with no submitted history is opened fresh. When a replacement thread is opened, the old transcript remains visible in Orchestra but is not restored as that thread's conversation history.

In live Codex mode, when App Server requests permission for a coder's file change, Orchestra shows the patch in that coder's chat and marks the agent as needing attention. Open the request and choose **Approve** or **Decline**. Approval applies to the displayed patch in the assigned feature worktree. Ordinary edits already allowed by the sandbox can proceed without prompting.

Orchestra declines command approval requests, session-wide grants, and file changes whose scope it cannot verify. A changed or withdrawn request expires in the chat. File approval does not merge the worktree into the project branch. The browser path is verified against an App Server fixture. Reproduce with `node --test tests/codex-approval.test.ts`. A live App Server account run that emits an eligible file-change request still needs verification.

A detected usage limit blocks new work. Orchestra does not automatically clear that state when the allowance renews; restart the workspace server once the provider is available again. Drafts and queued messages remain available for review.

The checks above are a manual checklist, not a claim that the current workspace has been fully accepted. Live recovery of populated threads, real-provider file approval routing, general Codex shell and patch execution, and desktop lifecycle behavior remain to be verified or implemented. See [ROADMAP.md](ROADMAP.md) and the historical [Codex](CODEX-SPIKE.md) and [delivery](DELIVERY-SPIKE.md) spike reports for their recorded results.

## Delegating from chat

- Ask the coordinator to implement a change. It can assign an isolated change directly to a coder or start a lead when scopes need coordination or integration. The lead assigns coders based on useful independent scopes. Each coder assignment creates a separate detached worktree from the project HEAD. The project must be a Git repository with at least one commit; uncommitted and untracked project changes are not included.
- Ask the pilot or lead to delegate a read-only analysis or design review. The coordinator or lead schedules a designer, reviewer, or tester with `afterAgentId` naming the exact coder. The checker appears beneath that coder and uses its candidate; Orchestra waits for the coder's submission before starting scheduled checks. Coders can also arrange their own independent checks. Designer feedback is advisory and does not replace required review or testing.
- When multiple accepted scopes must be delivered together, the lead calls `integrate_candidates` with their coder IDs. Orchestra snapshots their changes into a separate combined worktree, preserving source worktrees and the project branch. Conflicts fail explicitly. The lead delegates a tester with an integration/regression goal against that combined candidate, then uses `confirm_integration` after its current snapshot passes. This extra check is unnecessary for a single unchanged candidate.
- Ask the pilot to relay refinements to an existing lead. Ask the lead to send instructions to its workers. You can also open and message any agent directly.

The candidate remains on disk for inspection, and merging is manual. Tests that generate files or require missing dependencies may be blocked in the read-only tester session. Orchestra limits the workspace to 30 sessions and prevents conflicting coder and checker activity on the same candidate. In-memory prerequisites that were waiting when the server restarted are shown as interrupted so they can be scheduled again. The older `--feature` flag is accepted for compatibility with existing launch commands.

## Cross-repository delivery

Name the participating repositories in the pilot chat. A lead can be assigned several configured repository IDs, and each coder receives one repository and its own worktree. When several repositories are eligible for a repository-scoped assignment, the lead specifies the repository. A check attached to a coder uses the same worktree.

After accepting the relevant submissions, the lead prepares a delivery from all participating repositories. Orchestra combines multiple candidates within each repository and pins repositories with a single candidate. The joint tester receives the pinned worktree paths and tests their behavior together. Changes to a pinned candidate or its source submission require fresh validation. The lead chat lists the candidate paths and recorded joint result. Review and merge each repository separately.

## Reusing an archived team

Ask the pilot in the main chat to reuse the team by name, for example `Could you reuse the Contact Form team to add a confirmation dialog?`. If several archived teams share a name, the pilot asks you to reply with `Reuse team <ID>` for the intended one.

Reuse attaches fresh assignments to the stable team ID and keeps its repository assignments. The pilot chooses the roster for the new goal. A small change can use just one coder, while coordinated work can start a new lead. **Restore** remains available for reopening an earlier conversation. Reuse leaves those conversations and queues archived and gives new sessions a bounded handoff from accepted work. Coders start from the current committed baseline, so previous changes should be merged before assigning dependent work.

Orchestra derives team IDs for saved legacy leads and keeps those IDs across restart and reuse. Legacy teams can have a shorter handoff. The saved team handoff lasts while at least one of its conversations exists. Deleting the final conversation removes the team from **Archived** as well.

## Role instructions and project guidance

Orchestra loads the Markdown files in `roles/` into Codex as developer instructions. They define the pilot, lead, coder, reviewer, tester, analyser, designer, and product adviser. Designers review user experience and visual design in a read-only session; coders implement their recommendations. A project's `AGENTS.md` remains the place for repo-specific conventions and commands. Orchestra's runtime assigns worktrees and permissions independently of the Markdown.

A coder can use `raise_product_decision` to post an unresolved choice in the lead and pilot chats. The lead or pilot can delegate product advice and bring the remaining decision to the user. To pass review feedback to a coder, the lead uses `message_agent`.

The coordinator and lead can use `list_agents`, `message_agent`, and `read_agent_report` across its descendants. Coders can manage their own read-only checkers, but cannot confirm their own implementation. Reviewers and testers record pass, changes requested, or blocked against the submission and candidate snapshot assigned at check start. A new coder turn or changed candidate invalidates earlier results. Only the coordinator or lead that assigned the coder can confirm its submission. Confirmation requires passing evidence for whichever independent checks were specified or scheduled for the coder. Existing assignments without a verification plan keep their review and test requirements. Combined confirmation additionally requires current accepted sources and a passing tester for the exact integration snapshot. To continue an older candidate without scoped evidence, request fresh checks.

Delegated Codex assignments can mark narrow, predictable work as routine and demanding or high-risk work as complex. When the verified catalog lists them, the built-in provider favors Luna for routine work and Astra for complex work. Typical work uses the provider default. A custom provider uses its own configured model and effort. `CODEX_MODEL` overrides model selection for new sessions, and saved sessions retain their model and effort across resume. The conversation header shows Codex’s reported model and any effort Orchestra requested.

Each new pilot or lead turn includes a snapshot of the relevant agents' statuses and recent reports. Reports arriving during an active turn appear in chat and can be fetched with `read_agent_report`. The next turn includes the updated snapshot. Orchestra does not start extra model turns solely to deliver reports.

## Codex token accounting

Open **Token usage** in the workspace header to see observed totals and turn coverage. Agent chats show their own counts, and lead chats also show the rollup for their team. **Download usage JSON** downloads turn records, rollups by agent, team and orchestration run, and short delegation records. A run starts with a user message and includes work delegated from that turn. A user follow-up starts a new run.

Usage is collected from Codex App Server notifications for turns observed by Orchestra. A resumed session can replay a previous checkpoint, and a single turn can emit multiple updates. Totals include only observed usage, including usage from failed or interrupted turns when reported. A preexisting conversation may establish a baseline on its first observed update, so its earlier usage is unavailable. A turn without usage is shown as unknown. A turn interrupted by a restart can have partial coverage. When a gap prevents reliable turn attribution, the workspace total can include observed usage that is absent from the agent and run totals. Cached input and reasoning output are components of the reported breakdown. These are token counts. Account quotas and billed cost are separate.

Records live in a separate local `.usage.json` file alongside the workspace state. The export contains agent, run, provider thread and turn IDs, model labels and decision summaries, without prompts, file paths, or provider credentials. New delegation records include the handoff outcome at the time of the tool response, including queued, started, failed, or uncertain. Archiving preserves usage. Deleting an agent removes its attributable usage and decisions from future exports and rollups, including decisions that reference that agent. Demo and Claude mode do not collect usage. Custom Codex providers can report usage through the same protocol. Coverage depends on the provider emitting comparable cumulative checkpoints. Model labels describe the Codex thread settings and do not identify rerouted requests.

## Provider acknowledgements

A timed-out turn submission stays tracked as uncertain, with its queue paused, so late provider events can still resolve it. A timed-out steering message stays in the transcript with an uncertainty notice. Reconcile the conversation before retrying. These paths need further live provider validation.

## Orchestra rename compatibility

Use `ORCHESTRA_PORT` and `ORCHESTRA_STATE_DIR` for new setups. Their older `SWARMER_*` equivalents remain fallback aliases. When no state directory override is configured, Orchestra reads a legacy `swarmer` workspace if the corresponding `orchestra` file is absent, then saves future state under `orchestra`. Browser preferences similarly read the older key when the new key is absent and write subsequent updates under the Orchestra key. Historical spike reports retain the names and output captured during those runs.
