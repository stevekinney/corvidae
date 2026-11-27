# Codex delivery protocol

Codex runs the shared delivery sequence. This file holds Codex-only mechanics; shared outcome rules, including the brief's Delivery rule, live in the brief and Chef skill.

Codex may report `chef-worker` unknown in a disposable project. Register it with `-c agents.chef-worker.description=...` and `-c agents.chef-worker.config_file=<absolute .codex/agents/chef-worker.toml>`. Verify fresh-child metadata names `chef-worker`, `gpt-6.1-terra`, and `medium`. Do not substitute a general-purpose role.

1. Brief. Run `bun scripts/chef/brief.ts <ID> --repository stevekinney/corvidae --base <sha> --run <run> --json`; stop on refusal or blocker.
2. Implement. Start `.codex/agents/chef-worker.toml` in its own worktree with the brief. It runs `bun scripts/chef/focused-checks.ts`, pushes one candidate, and returns head plus status.
3. Review. Start `.codex/agents/stickler.toml` at that head with the brief's issue sections and `git diff <base>...<head>`.
4. Correction. Return findings to the same worker and review its new head once.
5. Pull-request rounds. Use `bun scripts/chef/review-threads.ts list --pr <n> --unresolved --json`, then `bun scripts/chef/review-threads.ts classes --pr <n>` before one push.
6. Deliver. The coordinator writes the request with `bun scripts/chef/delivery-request.ts prepare --branch <branch> --head <sha> --worktree <path> --base <sha> --run <id> --project <name> --issue <ID>... --route pull-request`, runs `bun scripts/chef/delivery-request.ts check --file <json> --digest <sha256>` once its run is green, then runs `bun scripts/chef/deliver.ts --pr <n> --head <sha> --worktree <path> --comment-file <file> --verification-file <json> --verification-digest <sha256> --run <id> --project <name>`; workers never merge.
