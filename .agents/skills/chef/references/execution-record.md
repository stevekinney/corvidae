# Execution record

Use one current work-history note as the durable orchestration record, with a short decision history rather than overlapping summaries. Fill these fields with inspected facts; an unknown that blocks safe execution remains an explicit blocker. The note lives at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work>.md`, which is gitignored, so it needs no frontmatter or index entry. Write every link, including source links, as an ordinary Markdown link.

Keep the note readable in one sitting, because a resuming coordinator reads it whole. On a measured four-day program run, an append-only note reached 1 MB, about a quarter of a context window.

- **The note holds current state:** identity, the batch table, open pull requests, live workers, blockers, the next executable action, and a decision history of one line per decision. It is rewritten in place at each batch transition and stays under about 300 lines.
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
- Scope gate: per package, the `worktree-scope` capture evidence path and `captureId`, the verify exit code after the first edit and before acceptance, any out-of-scope paths reported, and the coordinator's accounting. Record it as a detection gate, that concurrent writers were stopped for the check, and that unchanged dirty files stayed user-owned.
- Evidence: revision or relevant content identity, exact command and working directory, environment assumptions, exit code, evidence path, and invalidation reason if superseded. Reuse unchanged valid results, including across reviewers; raw logs are for specific diagnostic questions.
- Decisions: short timestamped history of choices, affected packages, invalidated verification, and one supported fallback per unavailable capability. A choice that Jev decided records the question, the answer, the probability, the model, and the threshold, with a pointer to its line in `jev-decisions.jsonl`; a choice made without Jev because it was unavailable or below its threshold says so. Do not retry a rejected dispatch without new capability evidence.
- Improvements: observation, owning team, duplicate search result, existing or created Linear issue, read-back result, and whether it blocks delivery.
- Final state: requirement-by-requirement evidence, pull requests and merge revisions, releases/deployments/adoptions where required, read-back issue/project states, worker disposition, and unresolved requirements.
- Resources: explicit user allowance if supplied (otherwise none specified); cached input, uncached input, and output separately, measured with `scripts/chef/transcript-usage.ts` over the run's transcripts; the coordinator's current context size; tokens per merged pull request by batch; plan-window readings; unknown telemetry explicitly marked. Session counters are not shared account quota. Report consumption and delivered outcomes after the first completed batch and before expanding a struggling batch. Repeated corrections or compaction without accepted results require reassessment, not silent expansion.
- Corrections: stable implementation owner and primary reviewer, consolidated unresolved findings, attempts per defect/acceptance criterion across workers and follow-ups, and causal reassessment after two unsuccessful attempts. Security and mandatory gates remain blocking regardless of spend.

## Worker charter

Resolve these fields before dispatching. A file reference is useful only if the worker can access it; otherwise include the necessary excerpt. Do not require workers to infer the assignment from a transcript.

```text
Package and outcome:
Source issue identifiers and relevant acceptance criteria:
Repository/artifact path and applicable instructions:
Exact base revision and assigned branch/worktree:
Assigned absolute mutation root:
Allowed files/interfaces and scope exclusions:
Review-boundary capture evidence path and captureId (from `scripts/chef/review-boundary.ts capture`):
Worktree scope capture evidence path, captureId, HEAD, and allowed paths (from `scripts/chef/worktree-scope.ts capture`; a detection gate, not prevention):
Dependency evidence already verified:
Shared repository packet and relevant source facts:
Role, requested model/effort, and escalation trigger:
Context: fresh dispatch or resume (resume only under about 250K tokens), and the compact brief for a fresh one (charter, open findings, diff or commit range, evidence paths):
Outcome matrix, for concurrency, replay, retry, or state-machine work (every input or failure crossed with every exit, each with its required result; the first test to write, red first), or "not applicable" with the reason:
Staged verification commands, working directory, and expected results (cheap checks/regressions, review/corrections, mandatory complete gates):
  Workspace-filtered gates (name commands and covered workspaces, or state why inapplicable):
  Repository-level gates (name unfiltered commands and separately invoked suites the change could affect, or explicitly state none apply and why):
Reusable evidence identities, environment assumptions, exit codes, paths, and invalidation conditions:
Primary reviewer and inherited correction-attempt counts:
Merge gate (corvidae: `bun run check` per pull request, run shared; a full `validate` only for a one-way door, lock or concurrency infrastructure, or `turbo.json` and root scripts):
Review rounds: one fix pass. After it, fix only a regression the fixes introduced or a serious defect on a one-way door; answer anything else in one line and resolve it; do not re-answer a re-reported comment.
Delivery artifact and review boundary:

Mutation protocol: `exec` workdir affects only that command. Before any write,
inspect an unknown tool's path semantics. `apply_patch` and file-edit targets
without a workdir parameter are absolute paths under the assigned mutation root;
writing `exec` calls set that root as workdir and use only contained paths. Before
the first mutation, report actual `git -C <canonical> status --porcelain` and
`git -C <assigned> status --porcelain` baseline reads. Change one authorized path,
then return its exact target and both statuses and stop for coordinator verification.
Do not make another mutation until the coordinator confirms the canonical checkout
is unchanged and the first change is confined to the assigned boundary. Unexpected
canonical changes stop work for ownership-preserving evidence and recovery; never
reset or automatically clean a checkout.

Inspect the existing codebase and match its conventions. Implement and verify
only this package. Add a regression test for each bug. Preserve other owners'
changes. Do not delegate, merge, write Linear, or edit the work-history note.
Do not skip gates, suppress failures, increase limits, or leave a required fix
as a follow-up. Take one review fix pass, as the charter's review-rounds line
says, and queue at most one full validate at a time. After two unsuccessful attempts at the same defect or acceptance criterion, stop
patching and return evidence for causal reassessment. Inherit prior attempts;
new agents, task names, or follow-ups never reset the count. Stop if required input, ownership,
permissions, or dependency evidence is missing.

Never leave background processes running. Start one (including a CPU load
generator) only if this charter requires it; record every PID, kill each before
returning, and report a `pgrep -fl "<pattern>"` that prints nothing.

Keep your context small. Every gate writes its full output to a log under the
evidence directory and prints only its exit code and a short summary; read a
failure with a targeted search, never by printing the log. Run one
consolidated gate command per stage, in the foreground within the tool's time
limit. Commit only after the package's lint and type checks pass, chained so a
failed check produces no commit. Show each regression test red with its fix
reverted, and restore the fix; a test that passes without the fix is not
evidence.

Return status: ready-for-review, blocked, or needs-decision.
Include changed behavior/files; branch, worktree, commit and pull-request URL;
commands and exit codes; evidence paths; outstanding review threads or checks;
actual model/effort if observable; blockers; and proposed process improvements.
Ready-for-review does not mean delivered. The coordinator runs
`scripts/chef/review-boundary.ts verify` and `scripts/chef/worktree-scope.ts verify`
against this package's capture evidence before accepting the submission; any
unaccounted removal or changed path outside the allowed set fails acceptance
regardless of the worker's own reported test results.
```

The coordinator fills every charter field or explicitly marks it inapplicable with a reason. A correction to an open pull request uses this same template, as a fresh charter or as a resume, under the context rule above; it never moves into the coordinator's context. Inspect repository instructions, root and affected workspace scripts, and CI configuration before naming verification gates; do not infer repository-level coverage from workspace-filtered commands or an aggregate validation script. Keep the saved assignment consistent with any follow-up change. Give a replacement worker the latest persisted state and relevant artifacts, not a stale initial charter.

## Provider references

When runtime behavior is unclear, verify it against the current tool schema and the official [Codex subagent documentation](https://developers.openai.com/codex/subagents) or [Claude Code subagent documentation](https://code.claude.com/docs/en/sub-agents). The [Codex skill documentation](https://developers.openai.com/codex/skills) describes discovery and UI metadata; `agents/openai.yaml` does not pin an agent model or grant dispatch permissions.
