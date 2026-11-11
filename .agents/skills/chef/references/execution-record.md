# Execution record

A run keeps one note at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work-name>.md` and a sibling `<note name>-log.md`. Take the main checkout from the parent of `git rev-parse --path-format=absolute --git-common-dir`, never the current directory, because a worktree's `tmp/` vanishes with it; write with Bash when the Write tool refuses a path outside the session's directories. Use the local timestamp, add a session suffix on a collision, and never overwrite another run's note. Persist the run identifier before dispatch, and reconcile a resumed note with live workers, revisions, and Linear before trusting it.

## The note

The note holds current state and stays under about 300 lines, because a resuming coordinator reads it whole. Rewrite a section in place with `bun scripts/chef/note.ts state <note> --section "<heading>" --file <content>` and a batch-table cell with `bun scripts/chef/note.ts row <note> --key <k> --column <c> --value <v>`, never `sed`. Timestamped events, evidence summaries, and correction narratives go to the log with `bun scripts/chef/note.ts log <note> --file <entry>`; the log is searched, never read whole, and the note cites it by timestamp.

- **Identity:** run identifier, start time and timezone, scope, source links, and status.
- **Acceptance:** one row per requirement with its owning package, binary completion predicate, verification command, and result.
- **Plan:** the package table (outcome, files, dependencies, batch, model and effort with a reason, verification), the dependency graph, and the critical path.
- **Execution state:** each package's status (`planned`, `running`, `review`, `blocked`, `complete`), worker, branch and worktree, head, review findings, and next action.
- **Evidence:** revision, command and directory, exit code, and evidence path; a result is reused only while all of these still hold.
- **Decisions:** one timestamped line each, with what it invalidates.
- **Corrections:** attempts per defect/acceptance criterion across workers and follow-ups, which no replacement resets, and the causal reassessment after two unsuccessful attempts.
- **Resources:** spend from `bun scripts/chef/transcript-usage.ts <transcript>`, tokens per merged change from the `deliver.ts --usage-log` file, every Opus or Fable implementer with its reason, plan-window readings, and the connectors turned off at run start.
- **Final state:** evidence per requirement, merge revisions, read-back issue and project states, worker disposition, and anything unresolved.

## Worker charter

The worker-facing rules have one source: `charterRules` in `scripts/chef/brief.ts`, which `bun scripts/chef/brief.ts <ID>` writes into every brief's `## Charter rules` section. A charter written without the script copies that section verbatim. The dispatch adds only what the brief cannot know:

- the package and outcome, when it differs from the issue (a slice, or a cluster of issues in one area);
- the readiness result: the claims verified at `HEAD` and the owner answers already given;
- the mutation root, when it is not a fresh worktree ([coordination](coordination.md#worktrees));
- the model and effort, with the reason for anything but Sonnet;
- the outcome matrix for concurrency, replay, retry, or state-machine work ([planning and routing](planning-and-routing.md#escalation));
- whether to open a pull request, and the handoff: the worker does not merge, and the coordinator delivers with `deliver.ts`;
- for a correction, the open findings and the inherited attempt counts.

The governing rules behind some charter rules, which a dispatch restates when they apply:

- `bun scripts/chef/review-threads.ts classes --pr <n>` exits 1 when one defect class has appeared in two or more review rounds; the worker pushes nothing more and returns blocked with its output.
- A test is deleted only with a recorded reason that its behavior no longer exists. A behavior difference from `main` is a regression unless the issue or a dated revision says otherwise.
- Show each regression test red with its fix reverted, and name the command or manual check behind each Verified criterion.
- A worker writes no Linear except moving its own issue to In Progress, and never edits the note.
