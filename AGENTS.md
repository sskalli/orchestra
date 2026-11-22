# Working on Orchestra

Read PRODUCT.md, TECHNICAL.md and ROADMAP.md before implementing. The team lead owns integration and milestone acceptance. Verify provider behavior against the current direct-task workflow.

Delegate bounded work to subagents with explicit outputs and file ownership. Use a separate reviewer to inspect integrated changes and a testing agent to exercise real scenarios. Ask a UX agent to review the workspace interactions before implementation and exercise them after integration. Parallelize independent work and coordinate edits where work is shared.

Use a separate worktree for independent feature implementations when available. Surface verification failures and unsupported provider behavior with reproduction steps. Fix recoverable issues and run the milestone checks on the integrated result. Ask the user about product decisions that materially change agreed behavior. Require their approval before merging into their project branch.
