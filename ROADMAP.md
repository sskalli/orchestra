# Roadmap

The workspace is currently a local Node server and browser UI, not a packaged desktop application. [WORKSPACE.md](WORKSPACE.md) describes the implemented controls and operational limitations. Status below distinguishes recorded spike acceptance from unfinished workspace integration.

## 1. Prove the Codex workflow

**Recorded status:** Accepted on November 11, 2026 for the terminal harness, including routed approval, queueing, and steering. See [CODEX-SPIKE.md](CODEX-SPIKE.md). This does not establish approval routing in the browser workspace.

Run a real local Codex App Server session signed in with ChatGPT. Prove that a coordinator can create a lead with a goal, the lead can start two workers, and a user can independently message either worker and see the reply on its thread. Capture an approval from a real worker and route it to the correct conversation. Verify queueing a follow-up while busy and record whether steering works. A terminal harness is sufficient. Record runtime version, reproduction steps, and any unsupported behaviors.

## 2. Prove parallel feature delivery

**Recorded status:** Accepted on November 11, 2026 for a disposable Git fixture using app-owned tools. General Codex shell and patch execution was not verified. See [DELIVERY-SPIKE.md](DELIVERY-SPIKE.md).

Give a lead a two-feature roadmap. Run two squads in separate worktrees, each with implementation, review, and testing. Demonstrate that the lead can integrate the results and present the combined diff and checks. Verify that the project branch changes only after the user's merge approval. Exercise a conflict and a failing check.

## 3. Build the workspace

**Status:** The browser workspace, chats, map, role-based delegation, and local persistence are implemented. Full milestone acceptance and live approval routing remain outstanding; see [WORKSPACE.md](WORKSPACE.md).

Deliver the charcoal three-panel workspace, radial canvas, animated chat docks, writable agent conversations and status icons defined in PRODUCT.md. Verify sibling placement, keyboard selection, pan and pointer-centered zoom, and click versus drag. Have a UX reviewer exercise the integrated workflow and recovery states.

## 4. Verify lifecycle and recovery

**Status:** Restart recovery and paused queues are implemented, but live populated-thread recovery and the full lifecycle are not yet verified. Desktop packaging and explicit quit behavior remain outstanding.

Close and reopen the window during a run. Reopen a saved project and confirm its chat, drafts and camera state. Exercise reconnect, usage limits, approval routing, queued messages, and quit with active teams. Confirm the app reports failures and preserves recoverable work.

## 5. Evaluate Claude

**Status:** Planned; Codex is the current provider.

Run a small integration spike for Claude Code after the Codex workflow is proven. Verify the applicable sign-in route and rerun the core messaging and approval checks before adding support to the product scope.
