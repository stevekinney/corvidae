# Program runs

Read this when the scope is a whole Linear project, or any work that spans more than one batch: a run of many batches over days, whose coordinator can lose its context without losing the run.

## Plan the program

- Pull every open child issue with the native relations that block it, including blockers outside the project, following pagination. Linear rejects a query that nests issues, labels, and relations past its complexity limit, so page issues in groups of 25 or fewer when you nest relations.
- Give each issue a wave: 0 with no open blocker, otherwise one more than its deepest open blocker. Group issues into batches by [the batching rule](planning-and-routing.md#batching) and record the batch table in the note.
- Leave out and report `type:decision` and `type:release` issues, tracking-only issues, and issues another session has claimed; a `type:decision` issue gets a question for the owner. A program built from a design canvas follows [design programmes](planning-and-routing.md#design-programmes).

## Dispatch on a rolling basis

- Release a batch as soon as every blocker of its issues is `completed`; don't wait for the rest of its wave. When more batches are releasable than slots, take the critical path first, then the batch that unblocks the most issues.
- The team-size limit covers the whole program. Corrections take the next free slot ahead of new work.
- Re-query the project after every merge; a new issue, a changed blocker, or a revised description updates the batch table.

## Main health

GitHub Actions is the full tier: the `main` workflow runs the full suite on every push to `main`, and its latest completed run is `main`'s health. `merge-gate.ts` warns, and never refuses, while that run is red, and reports `main health unknown` and proceeds when GitHub cannot be read. A pull request that repairs `main` is declared with `--fixes-main` on `bun scripts/chef/deliver.ts`. Read the run at a batch boundary or the end of a program run with `gh run list --workflow main.yml --branch main --limit 3`; nothing is run locally for it.

When the `main` run is red, read the failed jobs with `gh run view <id> --log-failed` and route each failure to the pull request that changed its package to its owner as a fix forward ([triaging a failed gate](review-and-deliver.md#triaging-a-failed-gate)).

Once a day, or before a release, launch `bun run harden` in the background, never per change. A failure follows AGENTS.md "Test tiers": a control against the base and a COR issue for the flake's mechanism, never a rerun until green.

## Promote Backlog issues to Ready

- Before claiming a Backlog issue, run `bun scripts/groom/groom.ts --issue <ID>`, which moves it to Ready when the Definition of Ready in [the Linear policy](linear-policy.md) holds; then claim it.
- A revision is material when it changes the outcome, an acceptance criterion, the scope, the delivery boundary, or the team; a material revision clears the intake gate again before the issue is claimed. When implementation shows an issue's text is wrong, append a dated revision instead of rewriting it.

## Combined changes

- One batch gets one branch, one worktree, and one change. Claim every issue in the batch against it, naming the others in each claim.
- Use one commit per issue where the work separates, and name every issue in the squash commit. Reference issues with a non-closing word such as `Refs`, never `Fixes` or `Closes`.
- Pass `deliver.ts` one `--issue <ID> --completion-file <md>` pair per issue and `--closes <ID>` for each issue the delivery completes; an issue the change only partly delivers gets no `--closes`.
- An issue has stalled after two failed corrections, a new native blocker, or a wait on an owner decision. Move its commits to a branch of its own, ship the rest, and return it to the queue with a `Blocked` or `Handoff` comment.

## Report at the project level

- When the first issue is claimed, move the project with `bun scripts/chef/linear.ts project-state <project> "In Progress"`.
- Post a project status update at the start, after each merged batch, and when the run stops, with `bun scripts/chef/linear.ts project-update <project> --health <onTrack|atRisk|offTrack> --file <md>`; it refuses a body without the count lines, which `bun scripts/chef/linear.ts project-read <project>` fills. Add the spend since the last update.
- Health is `onTrack` when every batch since the last update merged or was skipped for a reported reason, `atRisk` when a defect has had two failed corrections, and `offTrack` when a batch cannot proceed within the authorized boundary or two consecutive batches converged nothing.
- Move the project to `Completed` only once every child is Done and its Definition of Done holds.

## Recover the coordinator's state

The note and live Linear are the run's state; what the coordinator remembers is not. After a compaction or a restart, before any dispatch, merge, or Linear write, re-read the note's execution state and decisions, re-query every in-flight issue, list the open changes and worktrees the note names, and account for every live worker. Update the note at every batch transition, so that a fresh coordinator could resume from it alone.
