# Orchestra

Orchestra is a local workspace for running multiple Codex or Claude tasks across one or more Git repositories. Start a task from the map, follow its progress in the inbox, and open its conversation to plan, answer questions, or approve implementation.

## Install

Install Node.js **22.18 or newer**, then run these commands from the Orchestra repository.

```bash
npm ci
npm link        # makes the `orchestra` command available everywhere
```

## Launch

```bash
orchestra codex  ~/dev/app                  # Codex with your ChatGPT sign-in
orchestra claude ~/dev/app                  # Claude Code with your Claude sign-in
orchestra codex:myprovider ~/dev/app        # Codex with a provider from ~/.codex/config.toml
orchestra claude --project app=~/dev/app --project api=~/dev/api
orchestra demo                              # sample tasks, no sign-in needed
```

Without a path, Orchestra opens the Git repository in the current directory. Each launch checks the sign-in first and offers to run `codex login` or `claude auth login` for you. Codex is found on your `PATH` or in the ChatGPT desktop app, so `CODEX_BIN` is only needed for other locations.

Codex starts on port 4317 and Claude on 4327, and each moves to the next free port, so you can keep both open in separate tabs. Each engine keeps its own saved tasks for the same repositories. `npm run orchestra -- claude ~/dev/app` works without `npm link`.

Use **+** on the map to open a task. Choose repositories for code work or leave the selection empty for a general chat. A repo-backed task can read and plan before you click **Allow edits**. The same session then edits isolated worktrees, runs the agreed checks, and shows pinned revisions for review. You merge changes yourself.

Read [WORKSPACE.md](WORKSPACE.md) for configuration and recovery behavior.

## Verify changes

```bash
npm test
npm run build
```

See [PRODUCT.md](PRODUCT.md), [TECHNICAL.md](TECHNICAL.md), and [ROADMAP.md](ROADMAP.md) for product behavior, architecture, and remaining work.
