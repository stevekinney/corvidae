# Review and deliver

Read this when dispatching a review, accepting a submission, reading a failed delivery, or triaging a failed gate.

## Review

Review earns its keep on product concurrency changes, one-way doors, and diffs a careful reading can fault; a mechanical move a script proves needs none. Every review dispatch names the read-only `chef-reviewer` agent (`.claude/agents/chef-reviewer.md` as the Claude Code `subagent_type`, `.codex/agents/chef-reviewer.toml` on Codex), and its charter applies AGENTS.md "Review guidelines". Keep one implementation owner and one primary reviewer through a correction cycle, consolidate findings into one correction request, and keep review cheaper than the work it checks.

- The reviewer invokes no skills, including harness skills such as Claude Code's built-in `code-review`, which apply edits, and uses no file-editing tools. It records `git status --porcelain` and `git rev-parse HEAD` at the start and end, and the review fails if either differs. This is a charter rule, not a permission, so the coordinator checks the tree too.
- The reviewer reads [the defect classes](defect-classes.md) first and starts where the worker's defect-class report says a class applies. For a wrapper, adapter, or delegation change it checks that every property of the wrapped object (approval policy, idempotency, gating, identity, context binding) survives.
- A one-way-door review covers only the doors the change alters (a persisted format, a wire protocol, an authorization rule, a published surface) and runs after the primary review settles, unless the door is the change's main risk. A mechanical correction (a rename, a test fix, a documentation change) is verified at the economical tier.
- A change to Interborough's interface or Cinder also carries the `design-reviewer` verdict AGENTS.md "Workflow" requires, which the worker obtains under the `design-review` skill; it sits beside the correctness review and replaces none of it.

## Accepting a submission

A `ready-for-review` return is accepted only after `bun scripts/chef/leftovers.ts` is clean. Kill only processes you can attribute to this run by recorded PID; a leaked busy loop degrades every later gate. Acceptance authorizes delivery; a correction request is not acceptance, and the corrected head comes back as a new `ready-for-review`.

- Every acceptance criterion has one status (Implemented, Verified, Failed, Blocked, Not verified). A Failed one goes back as a correction, and an Implemented one needs its check run first. For a long criteria list, or one written outside this run, have the `stickler` agent audit it clause by clause.
- An issue that names design rows needs one `row-id | verdict | evidence` line per row from the `design-reviewer`, each `matches` or a `deferred` the issue records with a reason. A departure from a board is a defect, never style.
- A filtered gate speaks only for the workspaces it names; require evidence for every repository-level gate the change can reach. A green result can be a false witness (a replayed cache, an assertion whose subject no longer renders, a grep over output with ANSI escapes): assert on a captured exit status, and say whether a green came from a fresh run or a replay.
- If a worker crosses its authority boundary, stop it, inspect the actual effects, and record the incident before recovery.

## Exit codes

`bun scripts/chef/deliver.ts` exits 0 merged, 1 at a named step, and 2 on usage; its header defines every step. The skill covers `threads`, `conflict`, `revert`, `guards`, `head`, and `merge`. The rest:

- `mergeable`: GitHub's mergeability stayed `UNKNOWN`; launch it again shortly.
- `issue`: the merge happened, and a Linear comment or state change failed for the named issue; repair that issue with `bun scripts/chef/linear.ts comment <ID> --file <md>` or `bun scripts/chef/linear.ts state <ID> Done`, and do not relaunch.
- A delivery removes its worktree, or prints `worktree kept: <why>`; `worktree.ts stale --remove` clears leftovers.

A red `main` is a warning line in the report (`mainHealthWarning` in the JSON), never a refusal.

## Triaging a failed gate

Run `bun scripts/chef/gate-run.ts triage <log> --base <sha>` first, where `<sha>` is the `main` revision before the merges under test. It maps each failed task to the changes that touched its workspace, or reports it as pre-existing; route a mapped failure to that change's owner as a fix forward.

For anything ambiguous (a task several changes touched, a failure in a file none of them changed, a load-sensitive test), run `bun scripts/chef/gate-run.ts control --candidate <dir> --base <dir> --command <shell>` under the same load. Candidate fails and base passes: the candidate caused it. Both fail the same way: it is pre-existing and gets its own issue. Inconclusive: widen the control. Never rerun a gate until it passes in place of a control.

A full `validate` taken as an exception runs on GitHub once the head is accepted: push the branch, run `gh workflow run main.yml --ref <branch>` (its own concurrency group, so it never replaces a pending `main` run), and read it with `gh run list --workflow main.yml --branch <branch> --limit 1`.

## Preflights

Before every correction dispatch or delivery, read `gh pr view <number> --json state,headRefOid,mergedAt,url` for a pull request, `bun scripts/chef/linear.ts read <ID> --json`, and the worktree's `git status --porcelain` and `git rev-parse HEAD`, and compare them with the note. If the change merged, the issue closed, or the head moved elsewhere, stop the stale dispatch and reconcile. Read threads with `bun scripts/chef/review-threads.ts list --pr <number>` and a gate verdict with `bun scripts/chef/gate-run.ts read <log> --json`.

Move an issue to Done only when its boundary is proven (publication, deployment, and adoption verified against the real artifact), with the comment shapes and read-back rule in [the Linear policy](linear-policy.md). Close a requested project only when every required child passes, and never close a whole project when only some of its issues were requested.
