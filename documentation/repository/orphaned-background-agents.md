# Orphaned background agents

When a coordinator session's process restarts, the harness sends an orphan notice for the session's background shell commands, and none for its background agents. A `chef-worker` agent that stopped with the session simply goes quiet: nothing reports it, so a coordinator must not read silence as running.

On 2026-11-13 at 17:23 the Interborough and Cinder coordinator restarted. Two workers stopped mid-item with 15 unpushed commits and uncommitted work, and nothing reported it for eleven hours (COR-2464).

The repository cannot detect this from inside the harness. It narrows the damage two ways:

- A worker pushes its own branch after every commit (the charter's Push rule in `scripts/chef/brief.ts`), so finished commits reach the remote.
- The coordinator records each live worker in the run log and, after any restart or resume, runs `bun scripts/chef/workers.ts <run log>` first. It reads only, and reports each worker's worktree, last commit time, unpushed commits, uncommitted files, and whether its transcript changed in the last five minutes. The log entry format is in the [execution record](../../.agents/skills/chef/references/execution-record.md#worker-entries); the rule is in [coordination](../../.agents/skills/chef/references/coordination.md#run-the-team).
