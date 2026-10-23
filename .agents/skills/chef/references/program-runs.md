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
- Post a native project status update (`type: "project"`) at the start, after each merged batch, and when the run converges or stops. Each one gives counts: open issues, Ready, Done this run, batches merged, batches running, and blockers by identifier. It also gives consumption since the last update: tokens by tier from `scripts/chef/transcript-usage.ts`, tokens per merged pull request from the `merge-gate.ts --usage-log` file, any implementation dispatch that ran on Opus or Fable with its reason, and the plan-window reading. An update without counts fails this rule. Read each one back through the tracker (`get_status_updates` on the Linear connector).
- Set `health` to `onTrack`, `atRisk`, or `offTrack` (that exact spelling), using these binary thresholds: `onTrack` when every batch since the last update merged or was skipped for an expected, reported reason; `atRisk` when a defect has had two failed corrections; `offTrack` when a batch can't proceed within the authorized boundary, or two consecutive batches converged nothing.
- Move the project itself to `Completed` only through the `linear-update-project` skill where it is installed, or by the project rules in [the Linear policy](linear-policy.md) otherwise, once every child is Done and the project's Definition of Done holds.

## Recover the coordinator's state

- A long run compacts the coordinator's context. The work-history note and live Linear are the run's state; what the coordinator remembers is not.
- Don't wait for an automatic compaction near the window's limit. Every call above about 400K tokens re-reads that much context. On a measured run, calls above 700K were 45% of the coordinator's cost. At about 400K, bring the note's state section up to date, then compact or hand off to a fresh coordinator that resumes from the note.
- After a compaction or a resumption, before any dispatch, merge, or Linear write: re-read the note's execution state and decision log, re-query every in-flight issue, list the open pull requests and worktrees the note names, account for every live worker, and reconcile them.
- Update the note at every batch transition, so that a fresh coordinator could resume from the note alone. Rewrite its state section in place and append events to the sibling log, as `execution-record.md` describes; an append-only note grows past what a resuming coordinator can read.
