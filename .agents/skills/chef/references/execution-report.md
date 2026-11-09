# Execution report

Read this when writing a completion, blocker, or handoff comment for an issue. Each of those comments is an execution report in this form, so every attempt at an issue leaves one record a person can read in Linear without the transcript. [The Linear policy](linear-policy.md) "Work-session comments" says which comment each situation needs; this file says what goes in it.

## Form

The first line is the marker `Execution report: <branch> attempt <n>`. Level-2 headings, in this order: Execution status; Agent and session; Attempt; Branch and pull request; Requirements implemented; Acceptance criteria; Verification; Changes; Blockers and open questions; Remaining work.

`deliver.ts` refuses a `--completion-file` whose first line is not the marker or that lacks one of these headings in order, and `deliver.test.ts` keeps its list equal to the line above.

- **Execution status:** one of Complete (the pull request merged), Partial (stopped with work left, including an interrupted run), Blocked, or Failed.
- **Agent and session:** the provider, the model, and the session or agent id when known; otherwise "not available". Never a transcript path, a worktree path, or any other local path.
- **Attempt:** the attempt number, the base SHA, and the head SHA.
- **Branch and pull request:** the branch and the pull request link, or "none" when no pull request opened.
- **Requirements implemented:** each R-id with one line on what now holds.
- **Acceptance criteria:** each AC-id with exactly one status from the worker charter's return (Implemented, Verified, Failed, Blocked, Not verified) and its evidence. A Failed criterion may carry a one-line error summary, never a log. Unnumbered criteria are numbered AC1, AC2 here only; the issue is never edited to number them.
- **Verification:** each command with its real exit code, and each manual check as "Manual: <what was done>". Never write "tests pass" without a run that passed.
- **Changes:** the changed behavior and the files or workspaces it touched.
- **Blockers and open questions:** each blocker with its identifier and the one action that would unblock it, and each question for the owner; otherwise "None".
- **Remaining work:** what is left, or "None".

## Attempts

`n` is the number of execution reports already on the issue for that branch, counted across every page of comments, plus one, for a new run. A resumed run of the same attempt updates its own comment with `bun scripts/chef/linear.ts comment <ID> --update <comment-id> --file <md>`, which refuses a comment another user wrote. When the update is refused or fails, post a new comment and say so in it.

## Who posts it, and when

The coordinator posts every report, without asking the owner, because it is the only Linear writer for closeout:

- **Complete:** the report is the completion file that `deliver.ts` posts after the merge, before it moves the issue to Done.
- **Partial, Blocked, or Failed:** the report is the blocker or handoff comment, posted with `bun scripts/chef/linear.ts comment <ID> --file <md>`. A Blocked report also sets the native relation with `bun scripts/chef/linear.ts block <ID> --by <BLOCKER>`.

Chef's final report to the owner includes each report's link.
