# Codex capabilities for Orchestra v1

This follow-up to [the workflow spike](CODEX-SPIKE.md) checks model selection, token events, reconnect and local skills before changing workspace behavior.

## Reproduce

Use a recent Node.js version that supports the repository's TypeScript scripts and a working Codex installation.

```bash
node src/capability-spike.ts
node src/capability-spike.ts --inference
CODEX_PROVIDER=company CODEX_MODEL=your-model-id CODEX_EFFORT=low node src/capability-spike.ts --inference
```

Replace the model placeholder and use an existing provider from your Codex configuration. Model and effort are optional. `CODEX_BIN` and `CODEX_TIMEOUT_MS` work as in the workflow spike. The catalog is the first page from the App Server's default catalog. On the tested version its request does not accept a provider ID. The selected provider is sent explicitly when creating and resuming the thread.

The probe creates a disposable repository and candidate worktree with a fixture skill. It removes the fixture after the run. The default command only checks protocol setup, discovery and ephemeral thread creation. The inference command sends three short prompts, consumes provider quota and leaves a test conversation in Codex state so it can exercise resume. It inherits the installed Codex configuration, including any enabled plugins or hooks. Use a test configuration if those should be excluded. The probe uses read-only thread permissions and rejects approval and dynamic-tool requests.

## Observed on November 19, 2026

Codex CLI `0.166.0-alpha.5.1`, built-in `openai` provider and ChatGPT sign-in. The server reported the default model `gpt-6.2-sol`. It completed all three turns, resumed the same thread with the same provider and model in a new App Server process, discovered the committed fixture skill in both Git directories and returned the expected marker when given the typed skill input from the candidate worktree.

| Event | Thread total tokens | Most recent usage tokens |
| --- | ---: | ---: |
| First turn | 17,953 | 17,953 |
| Old first-turn event replayed on resume | 17,953 | 17,953 |
| Second turn | 37,130 | 19,177 |
| Skill turn, first update | 58,412 | 21,282 |
| Skill turn, second update | 79,793 | 21,381 |

A second run explicitly requested `gpt-6.2-sol` and sent `low` effort on each turn. All three turns completed, with one usage update each for the first two turns and two for the skill turn. Resume again replayed the first turn’s usage event.

All usage events carried both thread and turn IDs. The skill turn accounts for 42,663 tokens by cumulative difference. Its final `last` snapshot accounts for 21,381. The observed second turn had 17,792 cached input tokens. These are provider-reported counts from this run and do not establish a billing amount.

Restricted execution failed at fixture setup with `spawnSync git EPERM`. The same probe succeeded when run with permission to spawn Git and reach the configured backend. If a run fails, check the `probe.failed` stage in stdout. Set `CODEX_PROBE_DEBUG=1` for local diagnostics and review the output for sensitive provider details before sharing. The inference probe exercises a clean reconnect after a completed turn.

## Implementation implications

- Persist a per-thread cumulative checkpoint and attribute increases to the event's turn. Resume can replay an old event, and a single turn can emit several updates. Preserve missing usage as unknown and cover replay and multiple updates in the ledger tests.
- Keep provider selection separate from model and effort. The installed schema exposes `model` and `modelProvider` on thread start and resume, and `effort` on turn start. The probe reports thread-level selection metadata. It does not certify the effort used by inference.
- Use `skills/list` with the actual worktree path and the typed `skill` user input for explicit attachment. The installed schema supports `cwds` and `forceReload` for discovery. The successful fixture invocation establishes local repository skill compatibility. Desktop or ChatGPT account skill parity remains open.
- Before treating telemetry as complete, repeat against a configured custom provider and exercise usage after an interrupted turn and a disconnect during an active turn. Custom-provider model access and telemetry, interruption and ambiguous submission recovery were outside this successful run.
