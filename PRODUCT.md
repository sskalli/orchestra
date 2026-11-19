# Orchestra product spec

This document describes the intended product, including behavior not yet implemented. For the current browser workspace and known limitations, see [WORKSPACE.md](WORKSPACE.md); milestone evidence and remaining work are tracked in [ROADMAP.md](ROADMAP.md).

Orchestra is a local desktop workspace for coordinating coding agents. Open a Git project and give its coordinator a goal in the project chat. The coordinator creates team leads with goals ranging from a single feature to a roadmap release. Leads can split goals into squads, delegate implementation, review and testing, and report progress and blockers to the coordinator. Select any lead or worker to read its conversation and message it directly. Codex is the first provider. Claude is the next candidate.

## Workspace

The collapsible project chat lives on the left under the project name. A chevron slides it into a slim rail and expands it again. The center is a pannable, zoomable canvas. Clicking a node opens its writable chat on the right and names the recipient in the composer. Clicking empty space or pressing Escape clears selection and slides the right panel closed. Preserve drafts by thread. Dragging empty space pans without clearing selection. Zoom around the pointer with wheel or pinch. Provide Fit all teams and keep the viewed area anchored as panels open or close. Both chat docks and their input areas are resizable.

Use a dark terminal-style workspace. Use neutral white and gray text, with distinct role colors on agent avatars. Each team has a larger green lead, a goal label and faint concentric depth guides. Workers are small discs with soft, color-matched halos. Nodes remain stationary. Each level gets a wider ring. Center sibling groups at equal angular offsets around their parent's angle. Reveal straight links from hovered or selected nodes along their ancestor paths and to their direct children. Animate supported agent-to-agent events along direct visible links. Keep labels sparse and show role and activity on hover or keyboard focus.

Use compact multiline chat inputs without a focus outline, a terminal prompt marker, and a focus-visible text caret. Distinguish user messages with a lighter background and separate messages visually. Categorize system events by error, action required, warning, notice, or success.

## Agent interactions

Team structure follows useful work boundaries, not a fixed role count or one-coder-per-feature rule. A lead may use one coder for cohesive work or several for independent features or separable parts of a large feature. Each coder has an isolated candidate; its independent reviewers and testers appear as children of that coder. The lead retains acceptance authority. When separate candidates are combined, a tester under the lead validates their integration and regressions before combined acceptance. Avoid redundant delegation and reuse existing agents for repairs.

- Idle agents begin a new turn when messaged. Busy agents visibly queue messages for their next turn. Offer a separate Steer current turn action where supported.
- A spinner means working. Yellow warning means a question or approval needs your response. Green check means assigned work is done and the session remains open. Red warning means a run failed. Blue notice means an optional update is ready to inspect. Idle has no icon.
- Clicking a status icon opens the relevant conversation at the event. Roll worker warnings and failures up to the lead. If several workers need attention, let the user choose the request.
- Each independent feature squad uses its own Git worktree. Its developers, reviewers and testers operate on the same feature changes. The lead integrates completed work and presents the combined diff and test results. Require user approval before merging into the project branch.
- Closing the window keeps work running locally. Reopening restores the workspace, conversations and drafts. Explicit quit with active runs shows the affected teams and lets the user return or quit and stop the runs.
- Show sign-in, reconnecting, and usage-limit states. When the provider blocks new work, preserve the goal, transcript and queued input and explain why progress paused.
