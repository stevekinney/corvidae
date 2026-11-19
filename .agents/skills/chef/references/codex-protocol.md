# Codex delivery protocol

Codex runs the shared delivery sequence. This file holds Codex-only mechanics; shared outcome rules, including the brief's Delivery rule, live in the brief and Chef skill.

Codex profile observation: auto-discovery may report `chef-worker` unknown in a disposable project. Use the explicit role fallback, `-c agents.chef-worker.description=... -c agents.chef-worker.config_file=<absolute .codex/agents/chef-worker.toml>`, then verify fresh-child metadata names `agent_role: chef-worker`, `gpt-5.6-terra`, and `medium`. Do not silently substitute a general-purpose role. The coordinator recorded the native witness in `integration/p08-codex-profile-observed.json`; Claude's native `--agent chef-worker` witness is `integration/p08-claude-profile-smoke.jsonl` and resolved `claude-sonnet-5-5`.

1. Brief. Run `bun scripts/chef/brief.ts <ID> --repository stevekinney/corvidae --base <sha> --run <run> --json`; stop on refusal or blocker.
2. Implement. Start `.codex/agents/chef-worker.toml` in its own worktree with the brief. It runs `bun scripts/chef/focused-checks.ts`, pushes one candidate, and returns head plus status.
3. Review. Start `.codex/agents/chef-reviewer.toml` at that head.
4. Correction. Return findings to the same worker and review its new head once.
5. Pull-request rounds. Use `bun scripts/chef/review-threads.ts list --pr <n> --unresolved --json`, then `bun scripts/chef/review-threads.ts classes --pr <n>` before one push.
6. Deliver. The coordinator runs `bun scripts/chef/deliver.ts --pr <n> --head <sha> --worktree <path> --comment-file <file>`; workers never merge.
