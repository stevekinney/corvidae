# Chef assessment

The `cut` rows below were deleted by COR-2377 stage (b) on 2026-11-11; the table is left as the record.

An evidence-backed account of what each part of the chef process is used for, made for COR-2377 stage (a) on 2026-11-11. It deletes nothing: stage (b) deletes the `cut` rows after the owner or coordinator confirms this table. The measurements cover the 14 days to 2026-11-11 unless a column says otherwise.

## How to read the columns

- **Size** is `wc -l` lines and characters, plus 30-day commit count (`c`). **Tests** is the line count of the file's test files (`<name>.test.ts` and `<name>.*.test.ts`).
- **Sessions** is the number of Claude Code session transcripts (1,224 under `~/.claude/projects` for this repository, modified in the last 14 days, subagent transcripts included) that ran the script from a Bash tool call, then the number of such calls. **Runs** is the number of distinct run ids among the 52 top-level run notes and logs in the main checkout's `tmp/chef` (modified in 14 days) that name the file. For references and workflows, **Reads** is the number of transcripts that read the file with the Read tool.
- **Depends on it** lists the non-test files that import the script, or that name it, found by the commands below.
- A dash means not applicable (a library, a data file or a test helper has no command line).

## Commands that produce the counts

Run from the repository root; `<name>` is the file name without its extension, and `LIST` holds the transcript paths from the first command.

```sh
# the transcript list: Claude Code transcripts for this repository changed in the last 14 days
find ~/.claude/projects -path '*corvidae*' -name '*.jsonl' -mtime -14 > LIST

# Sessions and calls: Bash tool calls that start `bun` or `bunx` on the script
while read f; do
  grep -oE '"command":"([^"\\]|\\.){0,400}' "$f" \
  | grep -oE '(^|[;&|] *|"command":"|cd [^&;|]*&& *)(bun|bunx) +[^ ]*scripts/chef/<name>\.ts' \
  | sort | uniq -c
done < LIST

# Runs: distinct run ids (the first 17 characters of the file name) among the run notes
find <main checkout>/tmp/chef -maxdepth 1 -type f \( -name '2026-*.md' -o -name '2026-*.log' -o -name '2026-*.out' \) -mtime -14 \
  | xargs grep -lE '(^|[^a-z-])<name>\.(ts|json)'

# Reads: transcripts that read a reference, the skill or a workflow
grep -oE '"file_path":"[^"]*(skills/chef/references/<name>\.md|workflows/<name>\.js)' <transcript>

# Depends on it
grep -rlE "from '(\./|\.\./|.*chef/)<name>(\.ts)?'" --include='*.ts' --include='*.js' scripts .claude
grep -rlF "chef/<name>.ts" --include='*.ts' --include='*.md' --include='*.json' --include='*.js' . --exclude-dir=node_modules --exclude-dir=tmp

# Tests
cat scripts/chef/<name>.test.ts scripts/chef/<name>.*.test.ts | wc -l
```

A check that every file has a row (AC1); it prints each file with no row and exits 1 if there is any:

```sh
for f in $(ls scripts/chef/*.ts scripts/chef/*.json | grep -v '\.test\.ts$') \
  .agents/skills/chef/references/*.md .claude/workflows/*.js .agents/skills/chef/SKILL.md; do
  grep -qE "^\| \`$f\` +\|" documentation/repository/chef-assessment.md || { echo "no row: $f"; missing=1; }
done; exit ${missing:-0}
```

## What the delivery path needs

The seven files the brief names as the delivery path (`brief.ts`, `focused-checks.ts`, `deliver.ts`, `merge-gate.ts`, `linear.ts`, `worktree.ts`, `process-runner.ts`) import, with `direct-merge.ts`, this closure, and none of it may go: `credentials.ts`, `fetch-retry.ts`, `leftovers.ts`, `main-ci.ts`, `repository-config.ts`, `repository-locations.ts`, `review-threads.ts` (it reads `defect-classes.json`), `revert-check.ts`, `text-guards.ts`, `transcript-usage.ts` and `repository.json`. `worktree.ts` also starts `worktree-scope.ts` by name when given `--scope-paths`, which an import search does not show.

## The table

Verdicts are `keep`, `cut` or `shrink` (keep the file and delete a named part of it). A file used in the 14 days is `cut` only for a reason that is not low usage (AC4); the reason is in the last column.

### Scripts (`scripts/chef/`)

| File | Size | Tests | Sessions | Runs | Depends on it | Verdict | Purpose and reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scripts/chef/brief.ts` | 463 L, 23.4K, 16c | 573 | 35 / 283 | 5 | `deliver-issue.js`, `chef-worker.md`, `packet.ts`, `design-ledger.ts` | keep | Writes a worker's brief from one Linear issue. Delivery path (AC3). |
| `scripts/chef/command-spellings.test-support.ts` | 171 L, 6.8K, 0c | - | - | 0 | `command-spellings.test.ts` | keep | Test helper that checks every `bun scripts/chef/<script>.ts` spelling in the process documents against the script's header. It guards the references that stay. |
| `scripts/chef/credentials.ts` | 326 L, 13.2K, 1c | 447 | 6 / 35 | 2 | `linear.ts`, `jev.ts` | keep | Hands a credential to a command without printing it. `linear.ts` imports it. |
| `scripts/chef/defect-classes.json` | 116 L, 8.2K, 2c | - | - | 0 | `review-threads.ts` (default path) | keep | The classes `review-threads.ts classes` matches a thread against. Delivery closure. |
| `scripts/chef/deliver.ts` | 444 L, 20.6K, 12c | 996 | 13 / 108 | 12 | `deliver-issue.js`, `SKILL.md`, four references, three documents under `documentation/repository/` | keep | Runs a change's whole post-acceptance lifecycle in one command. Delivery path (AC3). |
| `scripts/chef/design-ledger.ts` | 267 L, 10.9K, 1c | 210 | 0 / 0 | 0 | `AGENTS.md`, `design-review/SKILL.md`; imports `brief.ts`, `linear.ts` | keep | Maps every design-canvas row to the issue that carries it; AGENTS.md says it checks the mapping, and a Nov 2 audit found 309 missed rows without it. Never run in 14 days, so the AGENTS.md rule is not enforced by anything (see the defects below). |
| `scripts/chef/direct-merge.ts` | 318 L, 14.5K, 2c | 372 | 0 / 0 | 0 | `deliver.ts`; `direct-merge-delivery.md` | keep | Squash-merges a pushed branch into `main` with no pull request, the owner's 2026-11-11 delivery. Reached through `deliver.ts`, never run by hand. |
| `scripts/chef/drift.ts` | 365 L, 14.3K, 2c | 566 | 0 / 0 | 0 | `triage.ts` only; `program-runs.md`, `decisions.md` | cut | Reports issues whose Linear state disagrees with GitHub. Not run once in 14 days (it was edited in a few sessions). Only `triage.ts` imports it. The need it names is real (see the defects below), so fix the premature Done in `deliver.ts` instead of keeping a report nobody runs. |
| `scripts/chef/fetch-retry.ts` | 45 L, 2.1K, 1c | 0 | - | 0 | `merge-gate.ts`, `direct-merge.ts` | keep | Retries a `git fetch` that loses a remote-tracking lock. Delivery closure. |
| `scripts/chef/focused-checks.ts` | 368 L, 13.7K, 2c | 273 | 57 / 277 | 2 | `AGENTS.md`, both workflows, `chef-worker.md`, `turbo-concurrency.integration.test.ts` | keep | The per-change gate. Delivery path (AC3). |
| `scripts/chef/gate-child.test-support.ts` | 87 L, 3.0K, 0c | - | - | 0 | `gate-run` tests | keep | Fake gate children for the `gate-run.ts` tests. Stays with `gate-run.ts`. |
| `scripts/chef/gate-run.ts` | 909 L, 37.5K, 6c | 1137 | 34 / 882 | 4 | `harden.ts`, `AGENTS.md` | keep | Runs, reads and controls the quality gate; AGENTS.md tells every worker to compare a failing test against the base with its `control` command. The largest file after `linear.ts`; shrinking it is a later question. |
| `scripts/chef/jev-predicates.ts` | 573 L, 22.0K, 3c | 370 | 6 / 21 | 0 | `triage.ts` (`--jev shadow`), both workflows, `codex-protocol.md`, `decisions.md` | cut | A registry of coordinator questions asked of an external model in shadow mode. By design it never changes control flow, and the shadow log holds 129 predicate lines against 20 recorded outcomes: nothing consumes the answers. Reason for the cut is that no output feeds a decision, not its usage count. |
| `scripts/chef/jev.ts` | 470 L, 19.5K, 1c | 480 | 1 / 3 | 0 | `jev-predicates.ts`, `decisions.md` | cut | Asks the Jev decision model one question and reports a probability. The decide path was used twice ever (`jev-decisions.jsonl` has 2 lines). It needs external credentials and has no other importer. |
| `scripts/chef/leftovers.ts` | 232 L, 8.8K, 1c | 275 | 190 / 567 | 1 | `worktree.ts`, `gate-run.ts`, `review-and-deliver.md` | keep | Reports what is still running or holding a resource after a batch; the worker charter ends every report with it. Imported by the delivery path. |
| `scripts/chef/linear.ts` | 1120 L, 44.5K, 7c | 1410 | 255 / 1932 | 4 | `deliver.ts`, `brief.ts`, `triage.ts`, `design-ledger.ts`, `drift.ts`, eight references | keep | Linear reads and writes as one call each. The most used script. Delivery path (AC3). Large, but a cut needs the owner (brief). |
| `scripts/chef/merge-gate.ts` | 587 L, 24.1K, 11c | 816 | 6 / 17 | 1 | `deliver.ts`, `direct-merge.ts`, `program-runs.md` | keep | Verify, comment, merge and confirm for one change. Delivery path (AC3). Few direct calls because `deliver.ts` runs it. |
| `scripts/chef/mutation-check.ts` | 330 L, 12.6K, 1c | 317 | 0 / 0 | 0 | nothing outside its own test | cut | Applies one mutation to prove a test fails without its fix. No run in 14 days (one session read it), no importer, no reference in the skill or AGENTS.md. A worker can edit the line and run the test. |
| `scripts/chef/note.ts` | 366 L, 13.9K, 2c | 271 | 10 / 576 | 0 | `execution-record.md`, `decisions.md` | keep | Edits a run's state note and log without rereading them. Heavily used by the few coordinator sessions that run it (576 calls in 10 sessions); it is what keeps the note out of the coordinator's context. |
| `scripts/chef/packet.ts` | 192 L, 6.6K, 1c | 80 | 10 / 37 | 0 | `SKILL.md`, `coordination.md`, `execution-record.md`; imports `brief.ts` | cut | One compact area packet per run. Replaced by the `chef-worker` agent type (18.4K start against 68.7K, audit) and by `brief.ts`. Twenty-seven packets exist; the newest was written on Nov 9, before `chef-worker` arrived on Nov 10, and none since. |
| `scripts/chef/process-runner.ts` | 183 L, 7.2K, 2c | 160 | - | 0 | 28 scripts import it | keep | The injectable seam for every external command. Delivery path. |
| `scripts/chef/repository-config.ts` | 173 L, 6.8K, 4c | 146 | - | 0 | ten scripts, including `deliver.ts` and `merge-gate.ts` | keep | Loads and validates `repository.json`. Delivery closure. |
| `scripts/chef/repository-locations.ts` | 41 L, 1.9K, 1c | 39 | - | 0 | seven scripts, including `brief.ts` and `worktree.ts` | keep | Finds the worktree and the main checkout. Delivery closure. |
| `scripts/chef/repository.json` | 15 L, 0.5K, 6c | - | - | 0 | `repository-config.ts`, `workspace-contract.integration.test.ts` | keep | Per-repository settings the scripts load. |
| `scripts/chef/revert-check.ts` | 151 L, 5.3K, 1c | 106 | 9 / 60 | 1 | `direct-merge.ts`, `AGENTS.md`, `chef-worker.md` | keep | Finds a branch that sets a file back to its earlier state. AGENTS.md runs it before every push; it is the check that replaces the two capture guards below. |
| `scripts/chef/review-boundary.ts` | 546 L, 16.9K, 1c | 349 | 0 / 0 | 0 | `execution-record.md`, `worktrees-and-scope.md` | cut | Captures a directory inventory and rejects an unaccounted removal. Not run once in 14 days (a looser search finds 6 sessions that only read it), no capture file exists in `tmp/chef`, nothing imports it. `revert-check.ts` and the `git diff --name-only` read before each push catch the same silent removal. |
| `scripts/chef/review-threads.ts` | 694 L, 25.7K, 3c | 773 | 174 / 1165 | 0 | `merge-gate.ts`, `answer-threads.js`, four references | keep | Lists, answers and resolves review threads and matches defect classes. Imported by `merge-gate.ts`. |
| `scripts/chef/scenario.test-support.ts` | 107 L, 4.5K, 0c | 112 | - | 0 | tests that start real processes | keep | Lets a test body start real processes. A repository guard depends on the pattern. |
| `scripts/chef/stash-guard.ts` | 116 L, 5.6K, 1c | 108 | - | 0 | `.claude/settings.json` (a hook), `AGENTS.md` | keep | The hook that denies a bare `git stash`. It runs on every Bash call without appearing as one, so the session count cannot measure it. |
| `scripts/chef/text-guards.ts` | 246 L, 10.5K, 2c | 429 | 0 / 0 | 1 | `direct-merge.ts` | keep | Runs the `lint:guards` guards one per process on the tree under test. It fails on a missing, empty or non-matching list, so the silent zero-guard failure cannot happen here. |
| `scripts/chef/transcript-usage.ts` | 462 L, 17.7K, 2c | 308 | 11 / 84 | 1 | `merge-gate.ts`, `direct-merge.ts`, `program-runs.md`, `execution-record.md` | keep | Sums token usage from transcripts; two delivery files import it. The audit's token figures came from it. |
| `scripts/chef/triage.ts` | 863 L, 33.1K, 5c | 630 | 7 / 54 | 5 | `SKILL.md`; imports `drift.ts`, `jev-predicates.ts`, `linear.ts` | shrink | Read-only Definition-of-Ready review. Of its 48 transcript calls 46 are `ready`, 2 are `stale` (both with `--jev shadow`), and none are `done`. Keep `ready`; delete `stale`, `done` and `--jev`, which also removes its imports of the two cut scripts. The lines this removes were not measured. |
| `scripts/chef/worktree-scope.ts` | 517 L, 17.1K, 3c | 660 | 34 / 405 | 0 | `worktree.ts` (starts it with `--scope-paths`), two references | cut | A baseline capture that detects a path changed outside an allowed set; its header says it "cannot stop a mutation". The newest capture file is from Oct 29. Replaced by `revert-check.ts` and the diff read before each push (AGENTS.md). Deleting it means removing `--scope-paths` and `--scope-output` from `worktree.ts`. |
| `scripts/chef/worktree.ts` | 507 L, 20.2K, 2c | 832 | 17 / 352 | 0 | `deliver.ts`, `worktrees-and-scope.md` | shrink | Creates and removes batch worktrees. Delivery path (AC3 keeps the file), so keep it, drop the scope options with `worktree-scope.ts`, and fix `remove`, which cannot remove a worktree the Agent tool made under `.claude/worktrees` (this run's log). |

### References (`.agents/skills/chef/references/`)

All thirteen total 141,498 characters (`wc -c`). Inbound links come from `SKILL.md` and the other references unless named.

| File | Size | Reads | Depends on it | Verdict | Purpose and reason |
| --- | --- | --- | --- | --- | --- |
| `.agents/skills/chef/references/codex-protocol.md` | 12 L, 2.4K | 2 | `scripts.md`, `SKILL.md`, `workflows.test.ts` | keep | The delivery sequence run by hand from Codex. The Codex hold is its own issue. Loses its Jev line when Jev goes. |
| `.agents/skills/chef/references/coordination.md` | 80 L, 19.5K | 5 | `AGENTS.md`, `SKILL.md`, `process-docs-moved-rules.test.ts` | shrink | The full rule behind each skill step; the second largest reference and a restatement of the skill. Cut it to the rules a step cannot do without. |
| `.agents/skills/chef/references/credentials.md` | 26 L, 3.0K | 0 | `decisions.md`, `SKILL.md` | keep | How a run gets a credential without printing it. Small; `credentials.ts` stays. |
| `.agents/skills/chef/references/decisions.md` | 85 L, 10.6K | 3 | `AGENTS.md` (owner-instruction rule), `SKILL.md`, five references | shrink | Owner and routine decisions. Most of it is the Jev procedure; keep the owner-instruction rule AGENTS.md links and drop the Jev sections with `jev.ts`. |
| `.agents/skills/chef/references/defect-classes.md` | 21 L, 3.8K | 113 | `chef-reviewer.md`, `brief.ts`, `SKILL.md` | keep | The eleven defect classes each worker checks a diff against. Read by 113 sessions, the most of any reference. |
| `.agents/skills/chef/references/execution-record.md` | 138 L, 18.5K | 8 | `brief.ts`, `command-spellings.test.ts`, `brief.test.ts`, `SKILL.md` | shrink | The fields of the run note. Ceremony the owner named: 18.5K for a note whose only consumer is the coordinator. Keep the fields `note.ts` edits; delete the capture and scope-gate sections with their scripts. |
| `.agents/skills/chef/references/execution-report.md` | 33 L, 3.4K | 1 | `deliver.ts`, `deliver.test.ts`, `linear-policy.md`, `scripts.md` | keep | The shape of a completion, blocker or handoff comment. `deliver.ts` names it, it is 3.4K, and it is cheap to read; the cost the owner named is in `execution-record.md`. |
| `.agents/skills/chef/references/linear-policy.md` | 68 L, 10.1K | 4 | `create-task/SKILL.md`, `create-project/SKILL.md`, `triage.ts`, four others | keep | The Linear rules a run relies on; two other skills link it. |
| `.agents/skills/chef/references/planning-and-routing.md` | 102 L, 16.1K | 7 | `AGENTS.md`, `focused-checks.ts`, `create-task/SKILL.md`, others | shrink | Work packages, grooming and routing. Keep what AGENTS.md and `focused-checks.ts` cite; the packet and Jev passages go with those scripts. |
| `.agents/skills/chef/references/program-runs.md` | 79 L, 15.8K | 7 | `deliver.ts`, `merge-gate.ts`, `test-lanes-and-checks.md` | shrink | Multi-batch runs over days. The batch validate timer is retired (COR-2374); drop the drift and Jev passages. |
| `.agents/skills/chef/references/review-and-deliver.md` | 81 L, 19.9K | 11 | `SKILL.md`, five references, `command-spellings.test.ts` | shrink | Review and gate detail. The most read after the defect classes, and the largest reference; trim restatement of `deliver.ts` and `merge-gate.ts` headers. |
| `.agents/skills/chef/references/scripts.md` | 40 L, 10.1K | 4 | `coordination.md`, `SKILL.md` | cut | An index of the scripts, which itself says "Each script's header holds its full usage". It repeats those headers and is the first place to name a deleted script. Replace it with the script names in the skill. |
| `.agents/skills/chef/references/worktrees-and-scope.md` | 49 L, 8.5K | 0 | `coordination.md`, `planning-and-routing.md`, `review-and-deliver.md` | shrink | Worktree mutation tiers and scope gates. Keep creation and cleanup; drop the scope-gate part with `worktree-scope.ts` and `review-boundary.ts`. |

### Skill, workflows and agents

| File | Size | Reads / sessions | Depends on it | Verdict | Purpose and reason |
| --- | --- | --- | --- | --- | --- |
| `.agents/skills/chef/SKILL.md` | 82 L, 18.9K, 2,583 words, 29c | 6 reads | the skill loader, every reference | shrink | The delivery sequence. Reads undercount a skill the loader injects. AC6 sets the target of 1,500 words; the Jev, packet, drift and scope steps leave with their scripts. |
| `.claude/workflows/answer-threads.js` | 121 L, 4.9K, 1c | 1 read, 22 sessions name it | `SKILL.md`, `codex-protocol.md` | keep | One review round: triage, answer, push once. Sessions that name it include injected skill text, so 22 overstates calls. Loses its Jev shadow call. |
| `.claude/workflows/deliver-issue.js` | 282 L, 9.7K, 2c | 2 reads, 25 sessions name it | `SKILL.md`, `codex-protocol.md` | keep | Prepare, implement, review, one correction. The delivery path (`brief.ts`, `focused-checks.ts`). Loses its Jev shadow call. |
| `.claude/agents/chef-reviewer.md` | 18 L, 2.2K | - | the review step of `SKILL.md` | keep | The read-only Opus reviewer. The audit counted 53 reviews with a blocker and 48 clean, and the ones read were product defects (AC3). |
| `.claude/agents/chef-worker.md` | 21 L, 2.3K | - | `brief.ts`, `focused-checks.ts` (it names both) | keep | The lean worker type: it starts at 18.4K tokens where a general-purpose worker starts at 68.7K (audit). |

## Totals

Of 54 rows: 36 keep, 8 cut (`jev.ts`, `jev-predicates.ts`, `worktree-scope.ts`, `review-boundary.ts`, `drift.ts`, `mutation-check.ts`, `packet.ts` and `scripts.md`), and 10 shrink (`triage.ts`, `worktree.ts`, `SKILL.md` and seven references). The cuts remove, implementation plus tests:

| Cut                              | Implementation | Tests | Total |
| -------------------------------- | -------------- | ----- | ----- |
| `jev.ts` and `jev-predicates.ts` | 1,043          | 850   | 1,893 |
| `worktree-scope.ts`              | 517            | 660   | 1,177 |
| `drift.ts`                       | 365            | 566   | 931   |
| `review-boundary.ts`             | 546            | 349   | 895   |
| `mutation-check.ts`              | 330            | 317   | 647   |
| `packet.ts`                      | 192            | 80    | 272   |
| `references/scripts.md`          | 40             | -     | 40    |

## Notes after the table

Three largest cuts by size, and what breaks if each goes:

1. Jev (`jev.ts` and `jev-predicates.ts`, 1,893 lines). `triage.ts` imports `jev-predicates.ts` for `--jev shadow`, both workflows and `codex-protocol.md` call the shadow predicates, and `decisions.md` is mostly the Jev procedure. Delete the flag, the two workflow calls and the sections in the same change. `credentials.ts` stays because `linear.ts` imports it.
2. `worktree-scope.ts` (1,177 lines). `worktree.ts` starts it when given `--scope-paths` and `--scope-output`, so those options go with it, and `worktrees-and-scope.md` and `execution-record.md` lose their scope sections. What is lost is a detection capture of changed paths; `revert-check.ts` and the diff read cover the silent-revert case that motivated it.
3. `drift.ts` (931 lines). Only `triage.ts` imports it; `SKILL.md`, `program-runs.md` and `decisions.md` name it. What is lost is the only report of a Linear state that disagrees with GitHub, so the premature-Done defect below must be fixed in `deliver.ts`, not left to a report.

Defects the evidence exposes:

- `deliver.ts --pr` moved an issue to Done while most of its slices were unmerged (this run's log). Nothing noticed, because `drift.ts` is never run. This is the case for fixing `deliver.ts`, and it is the one place the `drift.ts` cut costs something.
- `worktree.ts remove` cannot remove any worktree the Agent tool created, because they live under `.claude/worktrees` and not the provider root it accepts (this run's log). Worktrees accumulate until someone removes them by hand.
- AGENTS.md says `design-ledger.ts` checks the design-row mapping, and no session ran it in 14 days. The rule is not enforced by anything but a worker's memory.
- A guard runner that parsed its work list from `package.json` ran zero guards and reported success after the list moved (another run's log, 2026-11-11). `text-guards.ts` fails on a missing, empty or non-matching list, so it does not share the defect. I did not check `gate-run.ts` (the batch validate and the health record it also checked are retired, COR-2374) for a list they derive from another file.
- Nine fix-forward commits in another run were all a text guard, a type error or a test that never ran, and the Opus reviewer caught none of the type errors (the same run's note). The reviewer stays (AC3), and the gap is a type-check per landing, which `focused-checks.ts` already provides.

## What could not be measured

- Use that does not start with a Bash `bun` call: a script run by another script (`merge-gate.ts` runs several) or by a hook (`stash-guard.ts`) shows as no calls. Those rows say so.
- The session counts include transcripts of sessions that were building or editing the script, not only using it; a script's own development raises its count (`worktree-scope.ts` appears in five sessions on Nov 9 to 11, and I could not tell building from use). Counts are a floor for use and a ceiling for sessions that happened to touch it.
- The run notes mention scripts rarely by path, so the Runs column is a lower bound. Only 52 top-level notes fall in the 14 days; the remaining files under `tmp/chef` are gate and tool logs, which name every changed file and so say nothing about use.
- Reads of references and the skill are undercounts for the skill, which the loader injects without a Read, and say nothing about references the skill's text makes a worker read through a summary.
- The lines `triage.ts` would lose, the effect of the cuts on the 13,526 test lines the brief counts beyond the lines tabulated above, and the churn of deleted scripts (the 30-day commit count covers files that exist now).
- Whether the Jev shadow log's 20 outcomes show agreement: I counted records, not agreement.
- COR-2372 (worker charter and sizing rules) is open in the brief, which says to return blocked; the dispatch started this stage anyway.
