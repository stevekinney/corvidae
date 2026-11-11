# Codex delivery protocol

The same delivery sequence as the Claude Code workflow `.claude/workflows/deliver-issue.js`, run by hand from Codex. Work one issue at a time, at most two implementation workers at once (AGENTS.md "Parallel runs").

1. Brief. `bun scripts/chef/brief.ts <ID> --run <run> --json` writes `tmp/chef/briefs/<ID>.md`. Stop as blocked when it lists an open blocker.
2. Implement. Start the `chef-worker` agent from `.codex/agents/chef-worker.toml`, in its own worktree, pointed at the brief file only. It runs `bun scripts/chef/focused-checks.ts`, pushes its branch, and returns ready-for-review, blocked, or needs-decision, with the head. It delivers as the brief's Delivery rule says; steps 3 to 6 are the pull request path.
3. Review. Start the `chef-reviewer` agent from `.codex/agents/chef-reviewer.toml` against the diff at that head. It returns approve or the blocking findings.
4. One correction. On blocked, send the findings to a `chef-worker` in the same worktree. It runs `bun scripts/chef/focused-checks.ts`, pushes once, and returns the new head. Review that head again. A second blocked verdict is needs-decision for the owner.
5. Review rounds. For each round (at most three) run `bun scripts/chef/review-threads.ts list --pr <n> --unresolved --json`, fix and answer every thread, run `bun scripts/chef/review-threads.ts classes --pr <n>` before the push (exit 1 means push nothing), and push once.
6. Deliver. Move the issue with `bun scripts/chef/linear.ts state <ID> "In Review"`, then run `bun scripts/chef/deliver.ts --pr <n> --head <sha> --worktree <path> --comment-file <file>` in the background. The worker never merges.
