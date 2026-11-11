# Program runs

Read this when chef's scope is a whole Linear project, or any body of work that spans more than one batch. Everything in `SKILL.md` still applies. This adds what a run of many batches over days needs: a plan that stays live, issues promoted to Ready as their turn comes, pull requests that carry several issues, project-level reporting, and a coordinator that can lose its context without losing the run.

## Plan the program

- Pull every open child issue with the native relations that block it (its `blockedBy` side, including blockers outside the project), following pagination. Linear rejects a project query that nests issues, labels, and relations past its complexity limit (10,000), so page issues in groups of 25 or fewer when you nest relations.
- Give each issue a wave: 0 when it has no open blocker, otherwise one more than its deepest open blocker. Name the critical path, the longest chain of open blockers.
- Group issues into batches using [the batching rule](planning-and-routing.md#batching). Record a batch table in the work-history note: batch identifier, issues, repository, wave, files and contracts touched, review tier (Opus 5.5, or Fable 5.1 for a one-way door), and the evidence that releases it.
- Report and leave out `type:decision` and `type:release` issues, tracking-only issues, and issues another session has actively claimed. A `type:decision` issue gets a question for the owner, not an implementation.
- A program built from a design canvas follows [planning and routing](planning-and-routing.md) "Design programmes": the design ledger exits 0 before the first dispatch and again before the project closes, and the close also needs a full drift audit with no unexplained miss.

## Dispatch on a rolling basis

- Release a batch as soon as every blocker of every one of its issues is in a `completed` state, with evidence; a Canceled or Duplicate blocker is a question for the owner. Don't wait for the rest of its wave.
- The team-size limit in `SKILL.md` covers the whole program, not each wave. When more batches are releasable than slots, take the critical path first, then the batch that unblocks the most downstream issues, then milestone order.
- Serialize batches that touch the same files or contracts. On a shared host, also serialize heavy repository-wide validation instead of running several copies at once.
- Delivery runs no gate. Only a batch that is an exception under AGENTS.md "Gate on local checks" (a one-way door, the lock or concurrency infrastructure, `turbo.json` and the root scripts) takes a full `validate` before merging: once, after its review or verification accepts the head and the coverage and host preflights in [review and deliver](review-and-deliver.md) pass. A correction in flight makes any gate already running stale, so don't start one beside it. `main` moving is not a reason to rerun it; `merge-gate.ts` refuses only a real conflict with the base.
- Corrections to open pull requests take the next free implementation slot ahead of new work; no slot is held empty for them. A correction is never done in the coordinator's context.
- Re-query the project after every merge. A new issue, a changed blocker, or a revised description updates the batch table, with a one-line decision record.

## Batch validate on a timer

GitHub Actions runs the full suite on every push to `main` and per-change checks on pull requests, advisory for now (COR-2374). CI on `main` is the routine signal; run a local batch validate when CI cannot answer the question. The tier rules, moved from AGENTS.md "Gate on local checks":

- **Per batch:** run one `bun run validate:batch` on `origin/main` after a batch of merges lands, or at the end of a program run, as a background command: `bun run validate`, the root Playwright suite's `chromium` project, then Interborough's end-to-end suite (`bun run test:browser:interborough`), under one host lock (COR-2007). Fix a failure forward.
- **Main health:** `merge-gate.ts` warns, and never refuses, while the last batch validate on `main` failed; a fix for a red `main` is declared with `--fixes-main` on `scripts/chef/merge-gate.ts` or `scripts/chef/deliver.ts`. `bun scripts/chef/batch-validate.ts` runs the batch validate after five merges or two hours, one per host; schedule it with a Claude Code scheduled task or `/loop`, never with CI, cron files, or launchd plists.

`bun scripts/chef/batch-validate.ts --max-load 8` runs the batch validate (`repository.json`'s `batchCommand`, here `bun run validate:batch`, which is `bun run validate` followed by the root Playwright suite's `chromium` project and Interborough's end-to-end Playwright suite) on `origin/main` in the dedicated worktree `<worktree root>/batch-validate`, through `gate-run.ts`, so the result lands in `main`'s health record, which `merge-gate.ts` reads to warn, never refuse, while `main` is red. It runs only when `main` has moved since the last recorded batch head and either at least five merges have landed since that head or two hours have passed, and it skips when the health record already holds a green result at the current head. The load gate postpones a due run while the one-minute host load is 8 or higher. A host-wide lock in the Git common directory (`corvidae-batch-validate.lock`) keeps one batch validate running per host: a second coordinator exits 0 with "already running" instead of starting another. Otherwise it prints why it did not run and exits 0. `--dry-run` says what it would do. It runs for as long as the validate takes, so schedule it as a background command.

The script adds no scheduler. GitHub Actions runs the full suite on every push to `main` and per-change checks on pull requests, advisory for now, but the local batch validate is never scheduled with CI, cron files, or launchd plists (the main-health rule above). The coordinator schedules it from its own session:

- **Claude Code scheduled task:** create one that runs `bun scripts/chef/batch-validate.ts --max-load 8 --json` from the main checkout every 20 to 30 minutes, with a prompt that reads the one-line result, and on a failure (exit 1) runs `bun scripts/chef/gate-run.ts triage <log> --base <last green head>` and routes each mapped task to the pull request's owner as a fix forward.
- **`/loop`:** `/loop 30m bun scripts/chef/batch-validate.ts --max-load 8 --json`, ended with the run.

The same timer runs `bun scripts/chef/drift.ts --team COR --json` (add `--project <id>` in a program run). Once a day, or before a release, the coordinator also launches `bun run harden` in the background (never per pull request): it runs the isolated lanes repeatedly under generated load, and a failure follows AGENTS.md "Test tiers", a control against the base and a COR issue for the flake's mechanism, never a rerun until green.

`drift.ts` only reads: on exit 1 it lists each issue whose Linear state disagrees with GitHub (`merged-open`, `review-without-pr`, `stale-in-progress`), and the coordinator reconciles each one, closing it with an execution report, moving it, or recording a blocker. It is not a substitute for reading back each write.

A skipped run costs nothing but the tick, so a short interval is fine; do not start a second timer while one is live. When a run fails, route the fix forward: merges are not blocked on a red `main` and their reports warn while it stays red, and a pull request that repairs `main` carries `--fixes-main` on `merge-gate.ts` or `deliver.ts` so the health file records it. The next scheduled batch validate clears the record once it passes at a later head.

## Promote Backlog issues to Ready

- Before claiming an issue, check it against the Definition of Ready in [the Linear policy](linear-policy.md). When it holds, move it to Ready with a comment naming what was checked, then claim it (In Progress). In a program run, chef promotes issues itself; a separate draining workflow, such as the `drain-linear-project` skill where it is installed, only drains issues that are already Ready and keeps its own rule.
- A revision is material when it changes the outcome, an acceptance criterion, the scope or affected surfaces, the delivery boundary, or the team. A material revision clears the intake gate before the issue is claimed: the `intake-curmudgeon` agent where it is installed, otherwise the coordinator's own check of the revised text against the Definition of Ready, recorded in the note. Correcting a file path, naming a verification command the criteria already imply, or a routine status or evidence update is not material and needs no gate.
- A choice that is genuinely the owner's (product, architecture, or scope) follows [decisions](decisions.md): Jev decides at 0.9 or above, and otherwise it goes to the owner as a question with a recommended option. Never park it in a decision ticket. Keep working on batches that don't depend on the answer.
- When implementation shows an issue's text is wrong, append a dated revision to its description instead of rewriting history. The intake gate applies when the revision is material.

## Combined pull requests

- A wave usually holds several batches, and a batch may carry a short chain of dependent issues in one area across waves (for example, a handler and the authorization layered on it).
- Each batch gets one branch, one worktree, and one pull request. Claim every issue in the batch against that branch and worktree, and name the other issues in each claim so the shared branch is visibly intentional.
- Where the work separates cleanly, use one commit per issue, with the issue identifier in the subject. Title the pull request with the batch's outcome. In the body, give each issue its own section: identifier, acceptance criteria as a checklist, and the evidence for each (command and exit code, or test name). Reference issues with a non-closing word such as `Refs`, never `Fixes` or `Closes`, so a merge can't close an issue in Linear before its own evidence is checked.
- In a squash-only repository, list every issue identifier in the squash commit's subject or body.
- After the merge, move each issue to Done on its own acceptance evidence, with its own completion comment: pass `deliver.ts` one `--issue <ID> --completion-file <md>` pair per issue, in the order to close them.
- An issue has stalled when it has had two failed corrections, gains a native blocker, or waits on an owner decision. Split it out, keeping the open pull request for the remaining issues so its review threads stay together: rebuild the batch branch without the stalled issue's commits and push it with `--force-with-lease`, and put the stalled issue's commits on a branch of its own. When the commits didn't separate per issue, separate the change by hand, and have the primary reviewer re-review the batch's new diff. Ship the rest, and return the stalled issue to the queue with a `Blocked` or `Handoff` comment. Never hold an issue that is finished because another one in its batch isn't.
- Keep a batch reviewable in one pass. Split it when its diff no longer is.

## Report at the project level

- When the first issue is claimed, move the project to In Progress with `bun scripts/chef/linear.ts project-state <project> "In Progress"`, under the project rules in [the Linear policy](linear-policy.md), or record in the note why its status stays as it is.
- Post a native project status update (`type: "project"`) at the start, after each merged batch, and when the run converges or stops. Each one gives counts: open issues, Ready, Done this run, batches merged, batches running, and blockers by identifier. It also gives consumption since the last update: tokens by tier from `scripts/chef/transcript-usage.ts`, tokens per merged pull request from the `deliver.ts --usage-log` file, any implementation dispatch that ran on Opus or Fable with its reason, and the plan-window reading. Post it with `bun scripts/chef/linear.ts project-update <project> --health <health> --file <md>`, which refuses a body without the count lines (`Open:`, `Ready:`, `Done this run:`, `Batches merged:`, `Batches running:`, `Blockers:`) and reads the update back. `bun scripts/chef/linear.ts project-read <project>` gives the issue counts by state type to fill them.
- Set `health` to `onTrack`, `atRisk`, or `offTrack` (that exact spelling), using these binary thresholds: `onTrack` when every batch since the last update merged or was skipped for an expected, reported reason; `atRisk` when a defect has had two failed corrections; `offTrack` when a batch can't proceed within the authorized boundary, or two consecutive batches converged nothing.
- Move the project itself to `Completed` with `bun scripts/chef/linear.ts project-state <project> Completed` only once every child is Done and the project's Definition of Done in [the Linear policy](linear-policy.md) holds.

## Recover the coordinator's state

- A long run compacts the coordinator's context. The work-history note and live Linear are the run's state; what the coordinator remembers is not.
- Above about 200K tokens of context, restart from the run log at a batch boundary as a fresh session (AGENTS.md "Parallel runs"); otherwise automatic compaction is the backstop. Record `lastCtx` (`transcript-usage.ts`) in the note's state section at each batch boundary, and bring the state section up to date before any long wait.
- After a compaction or a resumption, before any dispatch, merge, or Linear write: re-read the note's execution state and decision log, re-query every in-flight issue, list the open pull requests and worktrees the note names, account for every live worker, and reconcile them.
- Update the note at every batch transition, so that a fresh coordinator could resume from the note alone. Rewrite its state section in place and append events to the sibling log, as `execution-record.md` describes; an append-only note grows past what a resuming coordinator can read.

## Reporting spend

Report spend without being asked, after the first completed batch and at every batch boundary: delivered outcomes; cached input, uncached input, output tokens, and model calls from `transcript-usage.ts`; calls and tokens per accepted result and per merged pull request; every implementer that ran on Opus or Fable, with its reason; and the provider's plan or rate-limit reading (Claude Code's desktop app reports it per session; Codex in each session log's `token_count` events). Record any user-provided allowance verbatim and never invent one. Compare the current batch with earlier accepted results and name the correction, review, and delivery shares when attribution exists. Two unsuccessful corrections or two batch transitions without an accepted result stop expansion for causal reassessment. When a plan window passes 75%, or calls or tokens per accepted result double, stop dispatching, report to the user, and revise the execution plan before continuing. Session counters are not account quota, and shared account usage cannot be attributed to this task. An existing user allowance persists; ask only for a real new budget boundary, scope change, ownership conflict, or quality compromise. Without telemetry, say so and use failed corrections or compactions without accepted results as the stop signal. Autonomous execution does not authorize unlimited spending; security findings stay blocking.

## Measured cost profile

On a measured four-day run the coordinator averaged about 530K tokens per call, and full-context cache rewrites after long waits were about a fifth of subagent spend. A later run found the fixed preamble was 133K tokens on the first coordinator call and 95K for a subagent, about 60% of coordinator tokens. Calls above 700K were 45% of the coordinator's cost on another run.
