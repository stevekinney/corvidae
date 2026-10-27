# Program runs

Read this when chef's scope is a whole Linear project, or any body of work that spans more than one batch. Everything in `SKILL.md` still applies. This adds what a run of many batches over days needs: a plan that stays live, issues promoted to Ready as their turn comes, pull requests that carry several issues, project-level reporting, and a coordinator that can lose its context without losing the run.

## Plan the program

- Pull every open child issue with the native relations that block it (its `blockedBy` side, including blockers outside the project), following pagination. Linear rejects a project query that nests issues, labels, and relations past its complexity limit (10,000), so page issues in groups of 25 or fewer when you nest relations.
- Give each issue a wave: 0 when it has no open blocker, otherwise one more than its deepest open blocker. Name the critical path, the longest chain of open blockers.
- Group issues into batches using `SKILL.md`'s batching rule. Record a batch table in the work-history note: batch identifier, issues, repository, wave, files and contracts touched, review tier (Opus 5.5, or Fable 5.1 for a one-way door), and the evidence that releases it.
- Report and leave out `type:decision` and `type:release` issues, tracking-only issues, and issues another session has actively claimed. A `type:decision` issue gets a question for the owner, not an implementation.

## Dispatch on a rolling basis

- Release a batch as soon as every blocker of every one of its issues is Done or Canceled, with evidence. Don't wait for the rest of its wave.
- The team-size limit in `SKILL.md` covers the whole program, not each wave. When more batches are releasable than slots, take the critical path first, then the batch that unblocks the most downstream issues, then milestone order.
- Serialize batches that touch the same files or contracts. On a shared host, also serialize heavy repository-wide validation instead of running several copies at once.
- Run a batch's repository-wide gate once, after its review or verification accepts the head. A correction in flight makes any gate already running stale, so don't start one beside it. When `main` moves, merge it and run the gate once more; the shared task cache replays what the move didn't touch.
- Keep one implementation slot for corrections to open pull requests. A correction waits at the head of the queue for a slot; it is never done in the coordinator's context.
- Re-query the project after every merge. A new issue, a changed blocker, or a revised description updates the batch table, with a one-line decision record.

## Batch validate on a timer

`bun scripts/chef/batch-validate.ts` runs the batch validate (`repository.json`'s `batchCommand`, here `bun run validate`) on `origin/main` in the dedicated worktree `<worktree root>/batch-validate`, through `gate-run.ts`, so the result lands in `main`'s health record and `merge-gate.ts` can refuse a merge into a red `main`. It runs only when `main` has moved since the last recorded batch head and either at least five merges have landed since that head or two hours have passed, and only while the one-minute load average is under 8; otherwise it prints why it did not run and exits 0. `--dry-run` says what it would do. It runs for as long as the validate takes, so schedule it as a background command.

The script adds no scheduler, and this repository takes no CI, cron files, or launchd plists (AGENTS.md). The coordinator schedules it from its own session:

- **Claude Code scheduled task:** create one that runs `bun scripts/chef/batch-validate.ts --json` from the main checkout every 20 to 30 minutes, with a prompt that reads the one-line result, and on a failure (exit 1) runs `bun scripts/chef/gate-run.ts triage <log> --base <last green head>` and routes each mapped task to the pull request's owner as a fix forward.
- **`/loop`:** `/loop 30m bun scripts/chef/batch-validate.ts --json`, ended with the run.

A skipped run costs nothing but the tick, so a short interval is fine; do not start a second timer while one is live. When a run fails, merge nothing except the fix, passed to `merge-gate.ts` with `--fixes-main`, or, when the failure is a load flake whose test passes alone on `main`, a pull request carrying `--waive-load-flake <reason> --control-head <sha>`; the next scheduled batch validate clears the record once it passes at a later head.

## Promote Backlog issues to Ready

- Before claiming an issue, check it against the Definition of Ready in [the Linear policy](linear-policy.md). When it holds and every blocker is Done or Canceled, move it to Ready with a comment naming what was checked, then claim it (In Progress). In a program run, chef promotes issues itself; a separate draining workflow, such as the `drain-linear-project` skill where it is installed, only drains issues that are already Ready and keeps its own rule.
- A revision is material when it changes the outcome, an acceptance criterion, the scope or affected surfaces, the delivery boundary, or the team. A material revision clears the intake gate before the issue is claimed: the `intake-curmudgeon` agent where it is installed, otherwise the coordinator's own check of the revised text against the Definition of Ready, recorded in the note. Correcting a file path, naming a verification command the criteria already imply, or a routine status or evidence update is not material and needs no gate.
- A choice that is genuinely the owner's (product, architecture, or scope) follows [decisions](decisions.md): Jev decides at 0.9 or above, and otherwise it goes to the owner as a question with a recommended option. Never park it in a decision ticket. Keep working on batches that don't depend on the answer.
- When implementation shows an issue's text is wrong, append a dated revision to its description instead of rewriting history. The intake gate applies when the revision is material.

## Combined pull requests

- A wave usually holds several batches, and a batch may carry a short chain of dependent issues in one area across waves (for example, a handler and the authorization layered on it).
- Each batch gets one branch, one worktree, and one pull request. Claim every issue in the batch against that branch and worktree, and name the other issues in each claim so the shared branch is visibly intentional.
- Where the work separates cleanly, use one commit per issue, with the issue identifier in the subject. Title the pull request with the batch's outcome. In the body, give each issue its own section: identifier, acceptance criteria as a checklist, and the evidence for each (command and exit code, or test name). Reference issues with a non-closing word such as `Refs`, never `Fixes` or `Closes`, so a merge can't close an issue in Linear before its own evidence is checked.
- In a squash-only repository, list every issue identifier in the squash commit's subject or body.
- After the merge, move each issue to Done on its own acceptance evidence, with its own completion comment.
- An issue has stalled when it has had two failed corrections, gains a native blocker, or waits on an owner decision. Split it out, keeping the open pull request for the remaining issues so its review threads stay together: rebuild the batch branch without the stalled issue's commits and push it with `--force-with-lease`, and put the stalled issue's commits on a branch of its own. When the commits didn't separate per issue, separate the change by hand, and have the primary reviewer re-review the batch's new diff. Ship the rest, and return the stalled issue to the queue with a `Blocked` or `Handoff` comment. Never hold an issue that is finished because another one in its batch isn't.
- Keep a batch reviewable in one pass. Split it when its diff no longer is.

## Report at the project level

- When the first issue is claimed, move the project to In Progress through the `linear-update-project` skill where it is installed (otherwise by `scripts/chef/linear.ts` under the project rules in [the Linear policy](linear-policy.md)), or record in the note why its status stays as it is.
- Post a native project status update (`type: "project"`) at the start, after each merged batch, and when the run converges or stops. Each one gives counts: open issues, Ready, Done this run, batches merged, batches running, and blockers by identifier. It also gives consumption since the last update: tokens by tier from `scripts/chef/transcript-usage.ts`, tokens per merged pull request from the `deliver.ts --usage-log` file, any implementation dispatch that ran on Opus or Fable with its reason, and the plan-window reading. An update without counts fails this rule. Read each one back through the tracker (`get_status_updates` on the Linear connector).
- Set `health` to `onTrack`, `atRisk`, or `offTrack` (that exact spelling), using these binary thresholds: `onTrack` when every batch since the last update merged or was skipped for an expected, reported reason; `atRisk` when a defect has had two failed corrections; `offTrack` when a batch can't proceed within the authorized boundary, or two consecutive batches converged nothing.
- Move the project itself to `Completed` only through the `linear-update-project` skill where it is installed, or by the project rules in [the Linear policy](linear-policy.md) otherwise, once every child is Done and the project's Definition of Done holds.

## Recover the coordinator's state

- A long run compacts the coordinator's context. The work-history note and live Linear are the run's state; what the coordinator remembers is not.
- Never hand off for context size alone; automatic compaction is the backstop. Record `lastCtx` (`transcript-usage.ts`) in the note's state section at each batch boundary, and bring the state section up to date before any long wait.
- After a compaction or a resumption, before any dispatch, merge, or Linear write: re-read the note's execution state and decision log, re-query every in-flight issue, list the open pull requests and worktrees the note names, account for every live worker, and reconcile them.
- Update the note at every batch transition, so that a fresh coordinator could resume from the note alone. Rewrite its state section in place and append events to the sibling log, as `execution-record.md` describes; an append-only note grows past what a resuming coordinator can read.

## Reporting spend

Report spend without being asked, after the first completed batch and at every batch boundary: delivered outcomes; cached input, uncached input, and output tokens from `transcript-usage.ts`; tokens per merged pull request from the `merge-gate.ts` usage log; every implementer that ran on Opus or Fable, with its reason; and the provider's plan or rate-limit reading (Claude Code's desktop app reports it per session; Codex in each session log's `token_count` events). Record any user-provided allowance verbatim and never invent one. When a plan window passes 75%, or tokens per merged pull request double from the run's earlier batches, stop dispatching and report to the user; never silently continue an expanding run. Session counters are not account quota, and shared account usage cannot be attributed to this task. Routine authorized choices proceed without renewed permission; real budget boundaries, scope changes, ownership conflicts, and quality compromises need a user decision. Without telemetry, say so, and treat repeated corrections or compactions without an accepted result as the stop signal. Autonomous execution does not authorize unlimited spending; security findings stay blocking.

## Measured cost profile

On a measured four-day run the coordinator averaged about 530K tokens per call, and full-context cache rewrites after long waits were about a fifth of subagent spend. A later run found the fixed preamble was 133K tokens on the first coordinator call and 95K for a subagent, about 60% of coordinator tokens. Calls above 700K were 45% of the coordinator's cost on another run.
