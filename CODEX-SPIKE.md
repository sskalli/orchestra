# Milestone 1 · Codex App Server

The terminal spike launches a local App Server over stdio. The coordinator, lead, and two workers each have a provider thread. The coordinator and lead request delegation through App Server dynamic tools. The harness starts the delegated threads and turns, and addresses follow-up messages to the worker threads by ID.

This report records historical spike results, not current browser-workspace acceptance. For current setup and live limitations, see [WORKSPACE.md](WORKSPACE.md).

## Reproduce

Run from the repository root with Node.js 22.18 or newer and a Codex CLI signed in through ChatGPT. `CODEX_BIN` selects an installed executable and defaults to `codex`.

```bash
export CODEX_BIN="${CODEX_BIN:-codex}"
"$CODEX_BIN" --version
"$CODEX_BIN" login status
npm run --silent spike:codex
```

The harness uses an ephemeral fixture and responds to its worker's command approval with a denial. Its JSONL events identify provider threads and turns so that a run can be inspected for cross-thread routing. Run it against the signed-in account with access to the ChatGPT Codex backend.

The installed protocol bindings can be inspected independently.

```bash
schema_dir=$(mktemp -d)
"$CODEX_BIN" app-server generate-ts --experimental --out "$schema_dir"
```

## Real provider run · November 11, 2026

Desktop CLI `0.166.0-alpha.5.1` and Node.js `26.13.0`. `codex login status` reported `Logged in using ChatGPT`. The default App Server invocation failed to initialize SQLite under `~/.codex` in this execution environment. An isolated writable Codex home resolved startup while retaining the existing file-backed sign-in. This reproduction applies to the account setup used here. It creates a symlink to the existing auth store and does not copy its contents into the project.

```bash
probe_home=$(mktemp -d)
ln -s "$HOME/.codex/auth.json" "$probe_home/auth.json"
CODEX_HOME="$probe_home" npm run --silent spike:codex
rm -f "$probe_home/auth.json"
```

An independent stdio probe sent `initialize` with `experimentalApi: true` and `requestAttestation: false`, then `initialized` and `account/read` with `refreshToken: false`. Initialization succeeded. The account request returned `-32603` with `workspace routing discovery failed`. The probe continued with `thread/start` in the temporary directory with `ephemeral: true` and `approvalPolicy: "never"`. App Server returned `modelProvider: "openai"` and `model: "gpt-6.1-sol"`. It acknowledged a `turn/start` with a text input asking for `SWARMER_PROVIDER_SMOKE`. The event stream then showed the following sequence.

```text
turn/started      inProgress
error             Reconnecting... 1/5 through 5/5
error             workspace routing discovery failed
turn/completed    failed
```

The probe received zero agent message deltas and exited 1. In the same environment, `curl --connect-timeout 5 --max-time 8 --head --silent --show-error https://chatgpt.com/backend-api/` exited 6 with `Could not resolve host: chatgpt.com`. Local thread creation and turn submission passed. The regular-terminal run below verified model replies and routing.

To reproduce the local steering check, send `turn/steer` for the active thread on `turn/started`, first with an invalid `expectedTurnId` and then with the ID from that event. The real App Server rejected the first request with `-32600` and acknowledged the second with the original turn ID. It emitted the initial and steering user items. The turn still failed at workspace routing discovery, before the model could respond to the steering input.

## Live acceptance from the regular terminal

On November 11, 2026, the regular terminal completed the reproduction command above with Codex CLI `0.166.0-alpha.5.1`, Node.js `26.13.0`, ChatGPT Plus authentication, and `gpt-6.1-sol`. The run used the default Codex home. The user supplied the JSONL output. Times below are UTC.

| Time | Check | Evidence |
| --- | --- | --- |
| 21:03:49 | Delegation | The coordinator called `start_lead`. The lead called `start_workers`. All four threads completed with their expected reply markers. |
| 21:03:51 | Direct worker messages | Alpha and beta each returned their distinct marker on the addressed thread. |
| 21:03:56 | Worker approval | Request `2` was routed to alpha's active turn, acknowledged as declined, and followed by `SWARMER_APPROVAL_FINISHED`. |
| 21:04:06 | Busy queue | Beta's queued follow-up started after its busy turn completed and returned `SWARMER_QUEUED_FOLLOWUP`. |
| 21:04:06 | Current-turn steering | Steering targeted beta's active turn, which returned `SWARMER_STEERED`. |

The run ended with `spike.passed`. Milestone 1 is accepted. The earlier workspace routing failure remains reproducible in the restricted execution environment.

At the time of this run, the project branch was unborn and `git rev-parse --verify HEAD` failed. Feature worktrees require a committed starting tree.
