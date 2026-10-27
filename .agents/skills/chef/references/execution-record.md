# Execution record

Use one current work-history note as the durable orchestration record, with a short decision history rather than overlapping summaries. Fill these fields with inspected facts; an unknown that blocks safe execution remains an explicit blocker. The note lives at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work>.md`, which is gitignored, so it needs no frontmatter or index entry. Write every link, including source links, as an ordinary Markdown link.

Keep the note readable in one sitting, because a resuming coordinator reads it whole. On a measured four-day program run, an append-only note reached 1 MB, about a quarter of a context window.

- **The note holds current state:** identity, the batch table, open pull requests, live workers, blockers, the next executable action, and a decision history of one line per decision. It is rewritten in place at each batch transition and stays under about 300 lines.
- **Packets carry the repository facts:** before dispatching, write one compact packet per area to `<main checkout>/tmp/chef/packets/<area>.md` (exact paths, signatures and line numbers that matter, commands, settled rules), link it from every worker charter, and update it when a merge changes what it describes. `scripts/chef/packet.ts status <area>` prints its age and the commits that touched its paths since it was written.
- **A sibling log takes the detail:** timestamped events, raw evidence summaries, and correction narratives go to `<note name>-log.md` beside the note, which is appended (with `scripts/chef/note.ts log`) and searched, never read whole. Rewrite the state section with `scripts/chef/note.ts state` and a batch-table cell with `note.ts row`, so a failed write cannot truncate the note. `note.ts row` escapes the cell value and is the only way to edit the batch table; never `sed` it. Cite the log from the note by timestamp instead of copying it.

## Run record

- Identity: run identifier, start timestamp and timezone, coordinator/session, provider, requested scope, original source links, current status.
- Inputs: complete issue/project coverage, repository paths, exact base revisions, applicable instruction paths, current claims, and scope exclusions.
- Acceptance: one row per user requirement, the package that owns it, its binary completion predicate, verification command or provider query, and evidence/result.
- Dependency plan: package table and graph, dependency release evidence, overlapping files/contracts, batch membership, dispatch waves, and critical path.
- Routing: package, selected role/model/effort, actual settings if observable, selection rationale, supported dispatch mechanism, and escalation condition.
- Grooming: upfront intake or junior-engineer review, incremental context delivery, or a mixture; rationale, questions settled, and context still needed before dependent decisions.
- Batch closeout: acceptance criteria, required verification, integration artifact, issue state/read-back, and actual remaining dependencies. Close independently completed batches while preserving explicit whole-program gates.
- Execution state: package status (`planned`, `running`, `review`, `blocked`, `complete`), worker identifier, branch/worktree or artifact path, latest revision, review findings, and next command.
- Scope gate: per package, its mutation tier, the `worktree-scope` capture evidence path and `captureId`, the verify exit code before acceptance (and after the first edit in the shared, canonical, or production tier), any out-of-scope paths reported, and the coordinator's accounting. Record it as a detection gate, that concurrent writers were stopped for the check, and that unchanged dirty files stayed user-owned.
- Evidence: revision or relevant content identity, exact command and working directory, environment assumptions, exit code, evidence path, and invalidation reason if superseded. Reuse unchanged valid results, including across reviewers; raw logs are for specific diagnostic questions.
- Decisions: short timestamped history of choices, affected packages, invalidated verification, and one supported fallback per unavailable capability. A choice that Jev decided records the question, the answer, the probability, the model, and the threshold, with a pointer to its line in `jev-decisions.jsonl`; a choice made without Jev because it was unavailable or below its threshold says so. Do not retry a rejected dispatch without new capability evidence.
- Improvements: observation, owning team, duplicate search result, existing or created Linear issue, read-back result, and whether it blocks delivery.
- Final state: requirement-by-requirement evidence, pull requests and merge revisions, releases/deployments/adoptions where required, read-back issue/project states, worker disposition, and unresolved requirements.
- Resources: explicit user allowance if supplied (otherwise none specified); cached input, uncached input, and output separately, measured with `scripts/chef/transcript-usage.ts` over the run's transcripts; the coordinator's current context size; tokens per merged pull request by batch, read from the `deliver.ts --usage-log` file; every implementation dispatch that ran on Opus or Fable, with its reason; plan-window readings; unknown telemetry explicitly marked. Session counters are not shared account quota. Report consumption and delivered outcomes after the first completed batch, at every batch boundary without being asked, and before expanding a struggling batch. Repeated corrections or compaction without accepted results require reassessment, not silent expansion.
- Corrections: stable implementation owner and primary reviewer, consolidated unresolved findings, attempts per defect/acceptance criterion across workers and follow-ups, and causal reassessment after two unsuccessful attempts. Security and mandatory gates remain blocking regardless of spend.

## Worker charter

Resolve these fields before dispatching. A file reference is useful only if the worker can access it; otherwise include the necessary excerpt. Do not require workers to infer the assignment from a transcript.

```text
Package and outcome:
Source issue identifiers and relevant acceptance criteria:
Readiness pass result (claims verified at HEAD; owner answers already given):
Repository/artifact path and applicable instructions:
Exact base revision and assigned branch/worktree:
Mutation tier: fresh dedicated worktree made by `worktree.ts create`, or shared, canonical, or production checkout:
Assigned absolute mutation root:
Allowed files/interfaces and scope exclusions:
Worktree scope capture evidence path, captureId, HEAD, and allowed paths (from `scripts/chef/worktree-scope.ts capture`; a detection gate, not prevention):
Review-boundary capture evidence path and captureId (shared, canonical, or production tier only; from `scripts/chef/review-boundary.ts capture`):
Dependency evidence already verified:
Shared repository packet and relevant source facts:
Role, requested model/effort, and escalation trigger (implementation defaults to Sonnet; give the reason for Opus or Fable):
Context: fresh dispatch or resume (resume only while the agent's context is small), and the compact brief for a fresh one (charter, open findings, diff or commit range, evidence paths):
Outcome matrix, required in the charter before dispatching concurrency, replay, retry, or state-machine work (finish reasons, run, task or settlement lifecycle, parks or suspends, recovery or reattach, shutdown or dispose, retries) (every input or failure crossed with every exit, each with its required result; the first test to write, red first). Every row also carries the behavior on `main` today, filled from evidence (a test run or probe on `main`), and, for a row that changes it, the source: an issue line, a dated revision, or a COR decision the coordinator found by searching COR. The worker proves each row against `main` red first and lists divergences in its return. Or "not applicable" with the reason:
Staged verification commands, working directory, and expected results (cheap checks/regressions, review/corrections, mandatory complete gates):
  Workspace-filtered gates (name commands and covered workspaces, or state why inapplicable):
  Repository-level gates (name unfiltered commands and separately invoked suites the change could affect, or explicitly state none apply and why):
Reusable evidence identities, environment assumptions, exit codes, paths, and invalidation conditions:
Primary reviewer and inherited correction-attempt counts:
Review policy (also required in specialist reviewer charters): before suggesting a change, read linked COR issues and search the COR backlog across projects for matching behavior, symbols, and work; verify scope, status, acceptance criteria, and decisions, and cite matching tickets instead of duplicating requests. Disclose an unavailable lookup without making it a blocker. A ticket does not excuse a concrete blocker introduced by the diff. Accept pre-release breaking changes, update in-repository callers directly, and remove deprecated code in the replaced path without compatibility layers. Block only with a supported input or reachable interleaving, wrong result, and concrete consequence; omit nitpicks and optional refactoring. Read AGENTS.md "Review guidelines" and the chef reference "Review and deliver" before reviewing.
Merge gate (corvidae: `bun run check` per pull request, run shared, launched with `scripts/chef/gate-run.ts run`; a full `validate` only for a one-way door, lock or concurrency infrastructure, or `turbo.json` and root scripts, and the coordinator merges those):
Delivery: the worker does not merge; after acceptance the coordinator launches `bun scripts/chef/deliver.ts --pr <n> --worktree <path> --comment-file <file>` (with `--gate-log`, `--issue`, `--completion-file`, `--remove-worktree` as needed). the coordinator's command carries `--usage-log <main checkout>/tmp/chef/<run>-usage.log --transcript <worker transcript path>`, which `deliver.ts` passes to `merge-gate.ts`, and that log is the source of tokens per merged pull request. A pull request that removes or renames members also gets `--removed-names <file>`, one identifier per line, so `deliver.ts` fails at step `integration` on files other sessions landed against the old surface:
Parallel-run limits (AGENTS.md "Parallel runs"): at most three sessions or workers on the host; at most one full validate queued per session, and only for an exception.
Repository packet: `<main checkout>/tmp/chef/packets/<area>.md` (path; `packet.ts status <area>` exits 0, so it is fresh). Read it instead of rediscovering the code; read source only for the lines you will change.
Worker start: one fresh worker for this issue, a background `Agent` subagent on Claude Code (a subagent per `.codex/agents/` on Codex), started from its brief (`bun scripts/chef/brief.ts <ID>` writes `tmp/chef/briefs/<ID>.md`), Sonnet by default; it ends when its pull request merges. A separate `start_session` session only when the owner asked for one.
Main health: `merge-gate.ts` refuses to merge while `main`'s last batch validate failed, unless this pull request is the fix and the merge command carries `--fixes-main`, or the failure is a load flake and the merge command carries `--waive-load-flake <reason> --control-head <sha>`. A worker never waives; only an explicit owner instruction, quoted, allows `--waive-main-health --reason <owner quote>`, which records a waiver, not a fix.
Review rounds (AGENTS.md "Review guidelines"): answer every thread before merge; at most three rounds; round one fixes every real finding; rounds two and three fix only regressions, one-way-door defects, and real defects in changed lines; after round three, open items go to one follow-up issue; push once per round, because Codex reviews every push automatically, so batch a round's fixes into one push; do not re-answer a re-reported comment.
Delivery artifact and review boundary:

Mutation protocol: `exec` workdir affects only that command. Before any write,
inspect an unknown tool's path semantics. `apply_patch` and file-edit targets
without a workdir parameter are absolute paths under the assigned mutation root;
writing `exec` calls set that root as workdir and use only contained paths.
Unexpected canonical changes stop work for ownership-preserving evidence and
recovery; never reset or automatically clean a checkout.
- Fresh dedicated worktree: edit freely inside the root; do not stop after the
  first mutation. Give a reason in the return for every path you delete or
  rename.
- Shared, canonical, or production checkout: before the first mutation, report
  actual `git -C <canonical> status --porcelain` and
  `git -C <assigned> status --porcelain` baseline reads. Change one authorized
  path, then return its exact target and both statuses and stop for coordinator
  verification. Do not make another mutation until the coordinator confirms the
  canonical checkout is unchanged and the first change is confined to the
  assigned boundary.

Inspect the existing codebase and match its conventions. Implement and verify
only this package. Add a regression test for each bug. Preserve other owners'
changes. Do not delegate or edit the work-history note. Do not write Linear,
except to move this package's own issue to In Progress when you start. Do not merge;
the coordinator delivers after it accepts your ready-for-review return. Do not skip gates, suppress failures,
increase limits, or leave a required fix as a follow-up. Follow the charter's
review-rounds line, and queue at most one full validate at a time. After two
unsuccessful attempts at the same defect or acceptance criterion, stop
patching and return evidence for causal reassessment. Inherit prior attempts;
new agents, task names, or follow-ups never reset the count. Stop if required
input, ownership, permissions, or dependency evidence is missing.

Delete a test only with a recorded reason that the behavior it covered no
longer exists; deleting a failing test to get green is forbidden. A behavior
difference from `main` is a regression unless the issue body or a dated
revision says otherwise. `needs-decision` is for product choices, and its
return attaches the `main` comparison.

Before opening the pull request, check the diff against every class in
`.agents/skills/chef/references/defect-classes.md`, fix what applies, and
report each class's result in the return. Before every fix push, run
`bun scripts/chef/review-threads.ts classes --pr <n>`. On exit 1, one defect
class has appeared in two or more review rounds: push no further patch, and
return blocked with its output for causal reassessment.

End a turn only on a state change: merged, blocked, needs-decision, or
ready-for-review. Wait for a gate, a check, or a review bot in a background
command (or a foreground one within the tool's time limit) and keep working;
never end a turn to report that you are still waiting. Collect every
background command before you return.

Never leave background processes running. Start one only to wait on a gate,
or (including a CPU load generator) when this charter requires it; record
every PID, collect or kill each before returning, and report a
`pgrep -fl "<pattern>"` that prints nothing.

Keep your context small. Every gate writes its full output to a log under the
evidence directory and prints only its exit code and a short summary; read a
failure with a targeted search, never by printing the log. Run one
consolidated gate command per stage. Commit only after the package's lint and
type checks pass, chained so a failed check produces no commit. Show each
regression test red with its fix reverted, and restore the fix; a test that
passes without the fix is not evidence.

Report: your final message is the report, at most 15 lines; do not create a `report.md` or any other report file. Write logs and evidence under `tmp/chef/<package>/round-<n>/` in the main checkout, with a new directory for each correction round. Your final step runs `bun scripts/chef/leftovers.ts` and quotes its line.

Return status: merged, ready-for-review, blocked, or needs-decision.
Include changed behavior/files; branch, worktree, commit and pull-request URL;
commands and exit codes; evidence paths; the defect classes that apply and how
each was handled; outstanding review threads or checks; actual model/effort if
observable; blockers; and proposed process improvements. Ready-for-review does
not mean delivered. Before accepting the submission, the coordinator runs
`scripts/chef/worktree-scope.ts verify` against this package's capture
evidence, and `scripts/chef/review-boundary.ts verify` as well in the shared,
canonical, or production tier; any unaccounted removal or changed path outside
the allowed set fails acceptance regardless of the worker's own reported test
results. Acceptance is what authorizes the merge.
```

The coordinator fills every charter field or explicitly marks it inapplicable with a reason. A correction to an open pull request uses this same template, as a fresh charter or as a resume, under the context rule above; it never moves into the coordinator's context. Inspect repository instructions, root and affected workspace scripts, and CI configuration before naming verification gates; do not infer repository-level coverage from workspace-filtered commands or an aggregate validation script. Keep the saved assignment consistent with any follow-up change. Give a replacement worker the latest persisted state and relevant artifacts, not a stale initial charter.

## Provider references

When runtime behavior is unclear, verify it against the current tool schema and the official [Codex subagent documentation](https://developers.openai.com/codex/subagents) or [Claude Code subagent documentation](https://code.claude.com/docs/en/sub-agents). The [Codex skill documentation](https://developers.openai.com/codex/skills) describes discovery and UI metadata; `agents/openai.yaml` does not pin an agent model or grant dispatch permissions.

## Note naming

The note lives at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work-name>.md` with a sibling `-log.md`. Take the main checkout from the parent of `git rev-parse --path-format=absolute --git-common-dir`, never the current directory, because a worktree's `tmp/` vanishes with it. Notes live in the main checkout's `tmp/chef/`; write them with Bash when the Write tool refuses a path outside the session's directories. Create `tmp/chef/` when absent, use the actual local timestamp, add a session suffix on a collision, resume the same note for the same run, and never overwrite another run's. Persist the run identifier and timezone before dispatch; on resumption, locate that identifier even if the provider changed, and reconcile the note with live workers, revisions, and Linear before trusting it. A failed initial note write blocks dispatch. [The execution record](execution-record.md) gives the note's fields and the worker charter.
