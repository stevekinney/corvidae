# Execution record

A run keeps one note at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work-name>.md` and sibling log. Derive the main checkout from `git rev-parse --path-format=absolute --git-common-dir`; worktree `tmp/` vanishes with it. Persist the run identifier before dispatch and reconcile resumes with workers and Linear.

## The note

Keep the note under 300 lines. Rewrite sections with `bun scripts/chef/note.ts state <note> --section "<heading>" --file <content>` and table cells with `bun scripts/chef/note.ts row <note> --key <k> --column <c> --value <v>`. Put events in the log via `bun scripts/chef/note.ts log <note> --file <entry>`.

- **Identity:** run identifier, start time and timezone, scope, source links, and status.
- **Acceptance:** one row per requirement with its owning package, binary completion predicate, verification command, and result.
- **Plan:** the package table (outcome, files, dependencies, batch, model and effort with a reason, verification), the dependency graph, and the critical path.
- **Execution state:** each package's status (`planned`, `running`, `review`, `blocked`, `complete`), worker, branch and worktree, head, review findings, and next action.
- **Evidence:** revision, command and directory, exit code, and evidence path; a result is reused only while all of these still hold.
- **Decisions:** one timestamped line each, with what it invalidates.
- **Corrections:** attempts per defect/acceptance criterion across workers and follow-ups, which no replacement resets, and the causal reassessment after two unsuccessful attempts.
- **Outcome accounting:** identify each accepted outcome and link all attempts. Record source/task; provider; model/effort (or `unknown`); policy revision; completed criteria; reviewer effort; human intervention; verification time; and dated prices. Use `bun scripts/chef/transcript-usage.ts <transcript>` and `bun scripts/chef/outcome-accounting.ts verify-task-bank <path>` to count linked paths once; missing or unpriced data stays unknown. Account-wide usage is not outcome spend.
- **Resources:** record cumulative allowance, reservations, and actual spend across resumes; absent allowance is `unknown`, never zero. A soft limit stops dispatch or escalation; call a hard limit only when runtime enforcement is verified. Separately report throughput, outcome success, escaped seeded defects, cost, verification time, and intervention.
- **Final state:** evidence per requirement, merge revisions, read-back issue and project states, worker disposition, and anything unresolved.

## Worker entries

Log `worker-start agent=<id> issue=<COR-n> worktree=<path> branch=<branch> [transcript=<path>]` at dispatch and `worker-end agent=<id>` on return.

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
- A worker never runs a browser suite, design-review capture, `validate` or `harden` on the host: it pushes and runs `gh workflow run main.yml --ref <branch>`.
- A test is deleted only with a recorded reason that its behavior no longer exists. A behavior difference from `main` is a regression unless the issue or a dated revision says otherwise.
- Show each regression test red with its fix reverted, and name the command or manual check behind each Verified criterion.
- A worker writes no Linear except moving its own issue to In Progress, and never edits the note.
