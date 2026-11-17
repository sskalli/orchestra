# Orchestra

**Proof of concept.** The browser workspace is usable for local experiments; provider recovery and the complete delivery lifecycle are still under development.

Orchestra is a local workspace for coordinating coding agents through conversation. Discuss a project with its coordinator, ask it to create a team, and open any lead or worker's chat directly from the agent map.

The current application runs as a Node.js server with a React browser interface. Codex App Server is the first provider. Desktop packaging and Claude support are planned.

## Get started

Install Node.js **22.18 or newer**, then run these commands from the Orchestra repository.

```bash
npm ci
npm run workspace
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The default demo contains sample teams and conversations and uses no Codex allowance.

## Open your project

For a live session, install Codex and sign in through ChatGPT. The target project must be a Git repository. Creating a coder's worktree requires at least one commit.

```bash
codex login status
npm run workspace -- --live /absolute/path/to/project
```

If Codex is installed outside your `PATH`, select its executable explicitly.

```bash
CODEX_BIN=/usr/lib/chatgpt/resources/codex \
  npm run workspace -- --live /absolute/path/to/project
```

Live model turns consume the signed-in account's Codex allowance. Account billing and credit settings determine whether additional usage can incur charges.

The coordinator appears as **Computer** in the project chat. You can refine a goal before delegating work, ask for an analysis or design review, or create a team with a lead, coder, reviewer, and tester.

For example, ask the coordinator to implement a feature with acceptance criteria, arrange independent review, and schedule regression tests after the coder finishes. You can send follow-ups to the coordinator, lead, or individual workers throughout the workflow.

## Working with teams

- A lead's first coder assignment creates a detached Git worktree from the project's current commit. Uncommitted and untracked changes in the original checkout are excluded.
- Coders implement in their team's worktree and await confirmation. The lead can send feedback to the same coder, preserving its conversation context.
- Reviewers and testers check the candidate. Confirmation requires passing review and testing for the current submission. A new coder turn invalidates earlier check results.
- Analysers investigate project questions. Designers provide read-only UX and visual advice. Product advisers help clarify decisions. Designer advice supplements code review and testing.
- Project-specific conventions belong in the target repository's `AGENTS.md`. Orchestra's role responsibilities live in [roles/](roles/).

Candidate worktrees remain on disk for inspection. Integration into the project branch is currently manual.

## Workspace controls

- Select an agent on the map to open its conversation. Click empty space or press Escape to clear selection. Drag empty space to pan, scroll or pinch to zoom, and use **Fit all teams** to reframe.
- Role colors and halos identify agents. Leads summarize team status when the team is collapsed. Hover, focus, or select agents to inspect related links and statuses.
- Enter sends a chat message. Shift+Enter adds a line. Busy agents queue messages; **Steer current turn** sends input to an active turn where supported.
- Resize the chat panels and drag the divider above an input to adjust its height. Panel sizes, composer sizes, drafts, selection, and camera position are saved in the browser.
- System messages distinguish errors, actions required, warnings, notices, and successes. Markdown reports are rendered in chat.

The interface uses locally bundled IBM Plex Mono, neutral terminal styling, and a procedural starfield. Supported agent-to-agent events animate along visible map links.

## Local state and shutdown

Live agent identities, transcripts, queues, and Codex thread IDs are stored per project under `${XDG_STATE_HOME:-~/.local/state}/orchestra`. Browser preferences are scoped to the project, mode, and local server origin. Run one live server per project and state directory.

Closing the browser tab leaves the Node server running. Stop it with Ctrl+C in its terminal. Restart recovery reconciles saved threads with Codex and keeps ordinary queued messages paused for review. Scheduled assignments interrupted while waiting on another agent must be scheduled again.

| Setting | Purpose |
| --- | --- |
| `CODEX_BIN` | Codex executable, defaulting to `codex` on `PATH` |
| `ORCHESTRA_PORT` | Local server port, defaulting to `4317` |
| `ORCHESTRA_STATE_DIR` | Override the directory for saved live workspace state |

## Current limits

- Full browser-workspace and lifecycle acceptance is still pending. Recovery of populated live threads requires further verification.
- Live sessions use `approvalPolicy: "never"`. Unexpected live command and file-change approvals are declined. The demo approval controls and terminal approval spike have different coverage.
- Read-only tester sessions can be blocked by generated files or missing dependencies. General Codex shell and patch behavior depends on the local sandbox and remains an integration concern.
- A detected usage limit pauses new work. Restart the server after the provider becomes available again.
- Desktop packaging, explicit quit handling, and Claude integration remain on the roadmap.

See [WORKSPACE.md](WORKSPACE.md) for recovery details, manual checks, and operational limitations.

## Development and verification

```bash
npm test
npm run build
npm run spike:codex
npm run spike:delivery
```

The offline test suite covers the message simulation, worktree isolation, saved-state scoping, and team role numbering. The build bundles the browser client and does not perform a full TypeScript type check. The two spikes submit real Codex prompts when configured with a signed-in executable. The delivery spike uses a disposable Git fixture. Read their reproduction steps and recorded scope before running them.

| Document | Contents |
| --- | --- |
| [WORKSPACE.md](WORKSPACE.md) | Current behavior, launch instructions, and manual checks |
| [PRODUCT.md](PRODUCT.md) | Intended product and interactions |
| [TECHNICAL.md](TECHNICAL.md) | Target architecture and provider responsibilities |
| [ROADMAP.md](ROADMAP.md) | Milestone status and remaining work |
| [CODEX-SPIKE.md](CODEX-SPIKE.md) | Codex workflow evidence and reproduction |
| [DELIVERY-SPIKE.md](DELIVERY-SPIKE.md) | Parallel delivery evidence and reproduction |

## Try the message animation demo

Start the demo with `npm run workspace`, then paste this into the main chat. The command runs a fixed local scenario; the text describes it. It creates dummy agents and waits 1–5 seconds between handoffs without making Codex calls.

```text
/simulate team-messages

Create a team lead with a researcher and a PM.
The researcher returns a dummy solution analysis and says hello.
The lead tells me it received the hello.

The PM asks another researcher for a dummy design report,
then passes it to a designer to request a roadmap.

The designer ends with a fake error.
The PM reports the failure to the lead.
The lead asks me whether to retry or skip the roadmap.

Wait 1–5 seconds between handoffs.
```

Use **Fit all teams** to see the whole group. A small white dot travels along a connection for each supported handoff. The designer, PM, and lead finish in an error state, and the main chat shows an action-required update. The retry-or-skip question is the simulation's endpoint.

This repository is a proof of concept. Current behavior and limitations are described in [WORKSPACE.md](WORKSPACE.md).
