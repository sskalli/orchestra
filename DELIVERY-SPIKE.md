# Milestone 2 · Parallel feature delivery

The exercise uses a disposable Git project. Its two-feature roadmap adds a high-priority prefix and a completion suffix to task titles. Both squads edit the same return expression in separate worktrees so the lead has a conflict to resolve.

This report records historical fixture results, not general acceptance of the browser workspace. For current setup and live limitations, see [WORKSPACE.md](WORKSPACE.md).

## Local Git rehearsal

Two implementation agents produced the changes independently. An independent reviewer inspected the integration and a testing agent ran assertions against the resulting worktree.

| Check | Observed result |
| --- | --- |
| Isolation | The fixture had distinct project, two feature, and integration worktrees. |
| Conflict | Git reported a content conflict in `task.mjs` when integrating the second feature. |
| Failing check | Keeping the first feature's side produced `Build (completed)` where the combined check expected `[High] Build (completed)`. |
| Recovery | The resolved merge composed the prefix and suffix. All nine combinations of high, normal, and omitted priority with true, false, and omitted completion passed. |
| Review | The integration commit had both feature commits as parents and passed `git diff --check main integration`. |
| Project branch | The fixture's `main` stayed at the original commit while the candidate was prepared. At the time, Orchestra's own project branch had no commits. |

The rehearsal ran in `/tmp/swarmer-delivery.HyVpr6`. While that directory exists, inspect the combined diff and conflict with:

```bash
git -C /tmp/swarmer-delivery.HyVpr6/integration diff main integration
git -C /tmp/swarmer-delivery.HyVpr6/integration show --remerge-diff d4dc2f6
```

## Live Codex run

The first live run on November 11, 2026 reached the ChatGPT Plus account, started the lead, and dispatched both implementation threads. The priority worker reported that sandboxed shell access and patching failed. The fixture file still matched its baseline, so the harness stopped before integration or approval. The reply did not include the underlying sandbox error.

In the restricted execution session, `/usr/lib/chatgpt/resources/codex sandbox -- /bin/true` also failed before running the command. Bubblewrap reported that the App Server socket directory must be user-owned with mode `0700`. The regular-terminal worker reply did not establish whether it encountered this same error.

Use the regular terminal with the same ChatGPT sign-in that passed milestone 1. The executable defaults to `codex` on `PATH`; set `CODEX_BIN` if needed.

```bash
npm run --silent spike:delivery
```

The lead starts both squads through an App Server tool. Each squad has separate implementation, review, and test sessions. Fixture tools let the implementation and lead sessions submit the expected `task.mjs` source, reviewers inspect the actual diff, and testers run the assigned check. The host scopes each tool to the active turn and its assigned worktree. The harness supplies the exact expressions for both features and the conflict resolution, and performs the Git integration itself. This run exercises app-owned tools and a scripted Git integration, not independent problem solving or general Codex shell and patch execution.

When the lead presents the combined diff and checks, the harness prompts for `merge <candidate>`. Entering the displayed command advances only the disposable fixture's `main`. Press Enter to decline. The fixture is removed when the run finishes, so keep the terminal output as evidence.

Set `CODEX_TIMEOUT_MS` higher if the lead needs more than the default 120 seconds to finish both squads.

The harness also passed an end-to-end run with simulated App Server replies and real fixture Git operations. The fixture branch stayed at its baseline without a terminal, after an empty response, and after an incorrect candidate ID. Entering the exact candidate ID advanced the fixture branch. The milestone 1 harness passed its simulated checks after extracting the shared App Server transport.

## Live result after the fixture-tool change

On November 11, 2026, the regular terminal ran Codex CLI `0.166.0-alpha.5.1` with Node.js `26.13.0` and ChatGPT Plus. The user supplied the JSONL output.

| Check | Live result |
| --- | --- |
| Parallel delivery | Both implementations submitted source in distinct worktrees. Separate reviewers inspected the diffs and separate testers ran the assigned checks. Both squads passed. |
| Conflict and recovery | The completed-only candidate failed the combined check. Git reported a conflict in `task.mjs`. The same lead thread inspected the conflict, then submitted a resolution preserving both features. |
| Candidate review | The host verified completed, priority, and combined checks on candidate `2b7c6bec47e5c1483913bf3ad5d5c6ffb73bd457`. The lead presented the combined diff and results. |
| Declined approval | The run ended with `delivery.approval.declined`. Fixture `main` stayed at baseline `c18ba974e24c721f102531e0f94092ff2c46ee09`. |

## Live approval and milestone acceptance

A second regular-terminal run on November 11, 2026 repeated the parallel squad checks, the deliberate failing check, and conflict recovery. The lead presented candidate `029ba4cef7df1f800afc0f3b666b10010880db98` against baseline `5807aedeea46745a9668910afaebb90e5a33f355` with all three checks passing. The user entered the exact merge command shown at the prompt. The harness emitted `delivery.passed` with fixture `main` at the approved candidate.

Milestone 2 is accepted for the disposable Git fixture and app-owned tools. General Codex shell and patch execution remains unresolved. The restricted execution session still fails to resolve `chatgpt.com`.
