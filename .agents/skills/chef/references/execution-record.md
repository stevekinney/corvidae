# Execution record

Use one current work-history note as the durable orchestration record, with a short decision history rather than overlapping summaries. Fill these fields with inspected facts; an unknown that blocks safe execution remains an explicit blocker. The note lives at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work>.md`, which is gitignored, so it needs no frontmatter or index entry. Write every link, including source links, as an ordinary Markdown link.

Keep the note readable in one sitting, because a resuming coordinator reads it whole. On a measured four-day program run, an append-only note reached 1 MB, about a quarter of a context window.

- **The note holds current state:** identity, the batch table, open pull requests, live workers, blockers, the next executable action, and a decision history of one line per decision. It is rewritten in place at each batch transition and stays under about 300 lines.
- **Packets carry the repository facts:** before dispatching, write one compact packet per area to `<main checkout>/tmp/chef/packets/<area>.md` (exact paths, signatures and line numbers that matter, commands, settled rules), link it from every worker charter, and update it when a merge changes what it describes. `scripts/chef/packet.ts status <area>` prints its age and the commits that touched its paths since it was written.
- **A sibling log takes the detail:** timestamped events, raw evidence summaries, and correction narratives go to `<note name>-log.md` beside the note, which is appended (with `scripts/chef/note.ts log`) and searched, never read whole. Rewrite the state section with `scripts/chef/note.ts state` and a batch-table cell with `note.ts row`, so a failed write cannot truncate the note. Cite the log from the note by timestamp instead of copying it.

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
- Resources: explicit user allowance if supplied (otherwise none specified); cached input, uncached input, and output separately, measured with `scripts/chef/transcript-usage.ts` over the run's transcripts; the coordinator's current context size; tokens per merged pull request by batch, read from the `merge-gate.ts --usage-log` file; every implementation dispatch that ran on Opus or Fable, with its reason; plan-window readings; unknown telemetry explicitly marked. Session counters are not shared account quota. Report consumption and delivered outcomes after the first completed batch, at every batch boundary without being asked, and before expanding a struggling batch. Repeated corrections or compaction without accepted results require reassessment, not silent expansion.
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
Context: fresh dispatch or resume (resume only under about 250K tokens), and the compact brief for a fresh one (charter, open findings, diff or commit range, evidence paths):
Outcome matrix, for concurrency, replay, retry, or state-machine work (every input or failure crossed with every exit, each with its required result; the first test to write, red first), or "not applicable" with the reason:
Staged verification commands, working directory, and expected results (cheap checks/regressions, review/corrections, mandatory complete gates):
  Workspace-filtered gates (name commands and covered workspaces, or state why inapplicable):
  Repository-level gates (name unfiltered commands and separately invoked suites the change could affect, or explicitly state none apply and why):
Reusable evidence identities, environment assumptions, exit codes, paths, and invalidation conditions:
Primary reviewer and inherited correction-attempt counts:
Merge gate (corvidae: `bun run check` per pull request, run shared, launched with `scripts/chef/gate-run.ts run`; a full `validate` only for a one-way door, lock or concurrency infrastructure, or `turbo.json` and root scripts, and the coordinator merges those):
Merge command with every path filled in (`bun scripts/chef/merge-gate.ts ... --usage-log <file> --transcript <path>`), or "coordinator merges" with the reason:
Parallel-run limits (AGENTS.md "Parallel runs"): at most three sessions or workers on the host; at most one full validate queued per session, and only for an exception.
Repository packet: `<main checkout>/tmp/chef/packets/<area>.md` (path; `packet.ts status <area>` exits 0, so it is fresh). Read it instead of rediscovering the code; read source only for the lines you will change.
Session start: one fresh session for this issue, started from its brief (`bun scripts/chef/brief.ts <ID>` writes `tmp/chef/briefs/<ID>.md`), Sonnet by default; the session ends when its pull request merges. The context-ceiling hook warns at 250K tokens and urgently at 350K; it never blocks, so hand off at the next boundary between steps, with a fresh session and never a fork.
Main health: `merge-gate.ts` refuses to merge while `main`'s last batch validate failed, unless this pull request is the fix and the merge command carries `--fixes-main`.
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
except to move this package's own issue to In Progress when you start. Merge
only with the charter's merge command, and only after the coordinator has
accepted your ready-for-review return. Do not skip gates, suppress failures,
increase limits, or leave a required fix as a follow-up. Follow the charter's
review-rounds line, and queue at most one full validate at a time. After two
unsuccessful attempts at the same defect or acceptance criterion, stop
patching and return evidence for causal reassessment. Inherit prior attempts;
new agents, task names, or follow-ups never reset the count. Stop if required
input, ownership, permissions, or dependency evidence is missing.

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

Keep your context small; past about 250K tokens, write a handoff brief under `tmp/chef/` and hand off to a fresh session. Every gate writes its full output to a log under the
evidence directory and prints only its exit code and a short summary; read a
failure with a targeted search, never by printing the log. Run one
consolidated gate command per stage. Commit only after the package's lint and
type checks pass, chained so a failed check produces no commit. Show each
regression test red with its fix reverted, and restore the fix; a test that
passes without the fix is not evidence.

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
