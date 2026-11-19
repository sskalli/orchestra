# Roadmap

The workspace is currently a local Node server and browser UI, not a packaged desktop application. [WORKSPACE.md](WORKSPACE.md) describes the implemented controls and operational limitations. Status below distinguishes recorded spike acceptance from unfinished workspace integration.

## 1. Prove the Codex workflow

**Recorded status:** Accepted on November 11, 2026 for the terminal harness, including routed approval, queueing, and steering. See [CODEX-SPIKE.md](CODEX-SPIKE.md). This does not establish approval routing in the browser workspace. The [v1 capability spike](CODEX-CAPABILITY-SPIKE.md) records a separate live check of model selection, token events, reconnect and local skills.

Run a real local Codex App Server session signed in with ChatGPT. Prove that a coordinator can create a lead with a goal, the lead can start two workers, and a user can independently message either worker and see the reply on its thread. Capture an approval from a real worker and route it to the correct conversation. Verify queueing a follow-up while busy and record whether steering works. A terminal harness is sufficient. Record runtime version, reproduction steps, and any unsupported behaviors.

## 2. Prove parallel feature delivery

**Workspace follow-up:** Flexible multi-coder scopes, nested coder-specific validation, and isolated combined-candidate testing are implemented. Runtime fixtures pass; Git integration fixtures could not execute in the restricted development environment (`EPERM`) and live multi-coder provider execution remains to be verified. Project-branch merging stays manual and requires approval.

**Recorded status:** Accepted on November 11, 2026 for a disposable Git fixture using app-owned tools. General Codex shell and patch execution was not verified. See [DELIVERY-SPIKE.md](DELIVERY-SPIKE.md).

Give a lead a two-feature roadmap. Run two squads in separate worktrees, each with implementation, review, and testing. Demonstrate that the lead can integrate the results and present the combined diff and checks. Verify that the project branch changes only after the user's merge approval. Exercise a conflict and a failing check.

## 3. Build the workspace

**Status:** The browser workspace, chats, map, role-based delegation, local persistence, and Codex file-change approval routing are implemented. Full milestone acceptance and file approvals with a live Codex account remain outstanding. See [WORKSPACE.md](WORKSPACE.md).

Deliver the charcoal three-panel workspace, radial canvas, animated chat docks, writable agent conversations and status icons defined in PRODUCT.md. Verify sibling placement, keyboard selection, pan and pointer-centered zoom, and click versus drag. Have a UX reviewer exercise the integrated workflow and recovery states.

## 4. Verify lifecycle and recovery

**Status:** Restart recovery and paused queues are implemented, but live populated-thread recovery and the full lifecycle are not yet verified. Desktop packaging and explicit quit behavior remain outstanding.

Close and reopen the window during a run. Reopen a saved project and confirm its chat, drafts and camera state. Exercise reconnect, usage limits, approval routing, queued messages, and quit with active teams. Confirm the app reports failures and preserves recoverable work.

## 5. Evaluate Claude

**Status:** Experimental Claude Code coordinator chat is implemented. Local fixture tests cover the adapter. Live account validation and team workflow parity are outstanding.

Verify live authentication, streamed replies, cancellation, and follow-up recovery with an installed Claude Code CLI. Evaluate tool permissions, approval routing, and delegation before adding Claude Code to the team workflow. See [WORKSPACE.md](WORKSPACE.md#claude-code-mode) for the current scope and manual checks.
