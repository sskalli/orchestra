# Orchestra

Orchestra is a local workspace for running multiple Codex tasks across one or more Git repositories. Start a task from the map, follow its progress in the inbox, and open its conversation to plan, answer questions, or approve implementation.

## Try the workspace

Install Node.js **22.18 or newer**, then run these commands from the Orchestra repository.

```bash
npm ci
npm run workspace
```

Open [Orchestra](http://127.0.0.1:4317). The demo uses sample tasks and no Codex allowance.

## Work on your repositories

Install Codex and sign in through ChatGPT. Launch with a Git repository or a set of named repositories.

```bash
npm run workspace -- --live /absolute/path/to/project
npm run workspace -- --project app=/absolute/path/to/app --project api=/absolute/path/to/api
```

Set `CODEX_BIN` if Codex is outside your `PATH`. For example, use `CODEX_BIN=/usr/lib/chatgpt/resources/codex` with the bundled Linux executable.

Use **+** on the map to open a task. Choose repositories for code work or leave the selection empty for a general chat. A repo-backed task can read and plan before you click **Start implementation**. The same Codex session then edits isolated worktrees, runs the agreed checks, and shows pinned revisions for review. You merge changes yourself.

Read [WORKSPACE.md](WORKSPACE.md) for configuration and recovery behavior.

## Verify changes

```bash
npm test
npm run build
```

See [PRODUCT.md](PRODUCT.md), [TECHNICAL.md](TECHNICAL.md), and [ROADMAP.md](ROADMAP.md) for product behavior, architecture, and remaining work.
