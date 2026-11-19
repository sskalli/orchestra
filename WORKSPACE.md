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

The live workspace opens a coordinator conversation, labeled **Computer** in the project chat. Discuss or refine a goal there, ask it to start a team, or ask for a standalone analysis. Each delegated agent has its own chat, queue, and status. The local Node process serves the browser workspace; closing the browser tab does not stop that process. Stop the server explicitly when finished.

## Workspace controls

- Select an agent to open its chat. Drag the edges of the project and agent panels to resize them; the handles also support arrow keys, Home and End. On narrow screens the project panel is below the map and its top edge changes its height.
- Drag the divider above a chat input to adjust its height. Composer sizes are saved separately for project and agent chats. Enter sends a message; Shift+Enter adds a line. Drafts are preserved per conversation.
- Agent roles have distinct node colors and halos. Hover or focus a node to see its details and related links. Supported agent-to-agent events animate a dot along a direct visible map link; the coordinator has no map node.
- New system messages are labeled and colored by category: error, action required, warning, notice, or success. Older saved messages without a category remain neutral. Your messages have a lighter background and messages are separated by lines.

## Workspace checks

- Select a worker, enter a draft, switch to another worker, then return to the first. The original draft should still be there.
- Tab to a node, use the arrow keys to move focus, and press Enter to open its conversation. Escape should close the conversation and restore focus to the node.
- Drag an empty part of the canvas with a conversation open. The camera should move and the conversation should remain open. Click empty space to clear selection.
- Scroll over a node to zoom around that point. Use a two-finger pinch on a touch display or **Fit all teams** to reframe the canvas. Opening or closing a dock should preserve visible node positions on screen.
- In demo mode, open the delivery lead's status and choose the sample approval or failed check. The corresponding conversation should focus the relevant event.
- Message the busy Canvas worker to see the queue. Use **Steer current turn** to send input to the active turn separately.
- With the local server running, reload the tab. The selected conversation, project dock, camera and per-agent drafts should return. The new event stream should show the running server's transcript, queue and pending approvals.

Browser preferences, including drafts, camera and panel sizes, are scoped to the project, mode, local server origin, and Codex provider ID. Live Orchestra servers save agent IDs, transcripts, queues and Codex thread IDs by project and provider under `${XDG_STATE_HOME:-~/.local/state}/orchestra`. The default `openai` provider retains its existing state location. Set `ORCHESTRA_STATE_DIR` to use a different directory. Run one live server per project, provider, and state directory. Demo runs use sample data.

After a live server restart, Orchestra requests the saved threads from Codex. If Codex confirms an interrupted turn completed, its reply is restored. Otherwise the interrupted message is flagged for review. Previous approval requests expire, and ordinary queued messages stay paused until you select **Resume queue**. Scheduled assignments waiting on a prerequisite are instead marked failed and must be scheduled again. An active or unresumable thread is generally shown as unavailable; when an older tool registration needs refreshing, Orchestra instead opens a new thread with the current tools. A coordinator thread with no submitted history is opened fresh. When a replacement thread is opened, the old transcript remains visible in Orchestra but is not restored as that thread's conversation history.

The demo contains an approval control, but live sessions currently request `approvalPolicy: "never"`; unexpected live command or file-change approval requests are declined automatically. The live workspace does not yet provide the approval routing demonstrated by the milestone 1 spike.

A detected usage limit blocks new work. Orchestra does not automatically clear that state when the allowance renews; restart the workspace server once the provider is available again. Drafts and queued messages remain available for review.

The checks above are a manual checklist, not a claim that the current workspace has been fully accepted. Live recovery of populated threads, approval routing, general Codex shell and patch execution, and desktop lifecycle behavior remain to be verified or implemented. See [ROADMAP.md](ROADMAP.md) and the historical [Codex](CODEX-SPIKE.md) and [delivery](DELIVERY-SPIKE.md) spike reports for their recorded results.

## Delegating from chat

- Ask the coordinator to start a team for implementation. A lead's first coder assignment creates a detached worktree from the project HEAD. The project must be a Git repository with at least one commit; uncommitted and untracked changes are not included. The coder can write within that worktree.
- Ask the pilot or lead to delegate a read-only analysis or design review. Ask a lead to schedule a designer, reviewer, or tester after its coder. Orchestra holds that assignment until the coder finishes and reports the resulting turn in the lead and pilot conversations. Designer feedback is advisory and does not replace required review or testing.
- Ask the pilot to relay refinements to an existing lead. Ask the lead to send instructions to its workers. You can also open and message any agent directly.

The candidate remains on disk for inspection, and merging is manual. Tests that generate files or require missing dependencies may be blocked in the read-only tester session. Orchestra limits the workspace to 30 sessions and prevents conflicting coder and checker activity on the same candidate. In-memory prerequisites that were waiting when the server restarted are shown as interrupted so they can be scheduled again. The older `--feature` flag is accepted for compatibility with existing launch commands.

## Role instructions and project guidance

Orchestra loads the Markdown files in `roles/` into Codex as developer instructions. They define the pilot, lead, coder, reviewer, tester, analyser, designer, and product adviser. Designers review user experience and visual design in a read-only session; coders implement their recommendations. A project's `AGENTS.md` remains the place for repo-specific conventions and commands. Orchestra's runtime assigns worktrees and permissions independently of the Markdown.

A coder can use `raise_product_decision` to post an unresolved choice in the lead and pilot chats. The lead or pilot can delegate product advice and bring the remaining decision to the user. To pass review feedback to a coder, the lead uses `message_agent`.

The lead can use `read_agent_report` to retrieve workers' findings during its Codex turn. Reviewers and testers record pass, changes requested, or blocked against the current coder submission. A new coder turn invalidates earlier check results. Confirmation requires passing review and testing for the same submission. To continue a candidate created before these checks were recorded, ask the lead to relay any outstanding findings to the original coder, then schedule fresh review and testing.

Each new pilot or lead turn includes a snapshot of the relevant agents' statuses and recent reports. Reports arriving during an active turn appear in chat and can be fetched with `read_agent_report`. The next turn includes the updated snapshot. Orchestra does not start extra model turns solely to deliver reports.

## Provider acknowledgements

A timed-out turn submission stays tracked as uncertain, with its queue paused, so late provider events can still resolve it. A timed-out steering message stays in the transcript with an uncertainty notice. Reconcile the conversation before retrying. These paths need further live provider validation.

## Orchestra rename compatibility

Use `ORCHESTRA_PORT` and `ORCHESTRA_STATE_DIR` for new setups. Their older `SWARMER_*` equivalents remain fallback aliases. When no state directory override is configured, Orchestra reads a legacy `swarmer` workspace if the corresponding `orchestra` file is absent, then saves future state under `orchestra`. Browser preferences similarly read the older key when the new key is absent and write subsequent updates under the Orchestra key. Historical spike reports retain the names and output captured during those runs.
