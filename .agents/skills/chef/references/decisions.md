# Decisions and Jev

Read this when a run meets a choice that the evidence does not settle. The command line, wire format, and exit codes are in the header of `scripts/chef/jev.ts`.

Settle each choice with the cheapest authority allowed to settle it: the evidence first, then Jev, then the owner. A choice the repository, the code, or an instruction already settles is decided from that evidence, and you say what was picked. Neither Jev nor the owner is consulted for an answer that is already written down.

- **Jev**: TypeSafe AI's decision model. It returns probabilities for a yes/no, choice, or scale question, and no text. It needs `TYPESAFE_API_KEY`, resolved as in [credentials](credentials.md).
- **routine call**: a choice inside the authorized scope that the coordinator would otherwise make alone.
- **owner decision**: a product, architecture, or scope choice that is genuinely the owner's.

## Remit and thresholds

- Routine calls: Jev decides at a probability of 0.85 or above (`--kind routine`, the default).
- Owner decisions: Jev decides at 0.9 or above (`--kind owner`). Below that, ask the owner and show Jev's probabilities as the recommendation.
- Pass `--threshold <p>` only to raise a threshold for a specific call, never to lower one; a value below the kind's default is a usage error (exit 2).

## Never Jev's to decide

At any confidence, these go to the owner, or stay with the evidence and the instructions that already govern them:

- Irreversible or outward-facing actions: deleting, publishing, spending.
- Security and credential choices.
- Anything the owner reserved, including an approval boundary written in the request, an instruction file, or an issue.

A high probability on one of these is not permission. Do not rephrase a forbidden question as a routine one to get an answer.

## Decisions made by hand

The coordinator still makes these itself, asking Jev with `bun scripts/chef/jev.ts decide --kind <routine|owner> --question "<question>" --state "<summary>"` and one of `--yes-no`, `--choice <key>=<description>`, or `--scale <levels>` when the evidence does not settle them:

- every predicate in the table below, because shadow mode records Jev's answer and never acts on it;
- any other routine call (grooming depth, which of two compatible batchings to use, whether a failure is shared with the base);
- every owner decision, with Jev's probabilities shown as the recommendation when it does not clear 0.9.

`state` summarizes the options and evidence in a few sentences: what was observed, the counts that matter, and what each option costs or risks. Never send secrets, credentials, tokens, environment values, or personal data, and never paste logs or diffs; cite the evidence path in the note. A longer summary goes in `--state-file <path>` under the main checkout's `tmp/chef/`, never in tracked files.

- Exit 0 (decided): act on the answer; `no (p=0.98)` is a decision too. For a shared-failure question, a `yes` records the failure as shared and continues to the delivery boundary, and a `no` treats it as this change's blocker.
- Exit 1 (below the threshold): a routine call goes back to the coordinator, which decides from the evidence and records why (for a shared-failure question, widen the control run first); an owner decision goes to the owner.
- Exit 2: invalid usage, not an answer.
- Exit 3 (Jev unavailable): routine calls go back to the coordinator and owner decisions to the owner, with no probabilities. Record that Jev was skipped and why; do not retry in a loop or let the outage stall independent work.

## Jev predicates

`scripts/chef/jev-predicates.ts` turns the coordinator's recurring questions into Jev questions and runs them in shadow mode: `bun scripts/chef/jev-predicates.ts shadow <predicate> --evidence-file <json>` logs Jev's answer, `outcome <id> --actual <value>` logs the coordinator's, and `report` measures agreement. Shadow mode never changes control flow: no predicate decides until its agreement is measured and it is promoted. Every predicate is `routine` (threshold 0.85).

| Predicate | Rule it applies | Kind (threshold) |
| --- | --- | --- |
| `thread-triage` | AGENTS.md "Review guidelines": fix a real defect in changed lines, decline the out-of-scope or speculative, track what a COR issue already captures | routine (0.85) |
| `review-tier` | One-way doors, locks, and `turbo.json` get full review; small two-way-door changes light; mechanical or documentation-only none | routine (0.85) |
| `dispatch-plan` | AGENTS.md "Parallel runs": an economical model when the interfaces are known and the issue has tests, a stronger one for one-way doors | routine (0.85) |
| `split-before-dispatch` | [Sizing and splitting](planning-and-routing.md#sizing-and-splitting): split an issue too large for one reviewable pull request | routine (0.85) |
| `flake-verdict` | AGENTS.md "Test tiers": a flake fails on the base too or passes on a rerun of the same head; a regression fails only on the head, consistently | routine (0.85) |
| `drift-action` | `scripts/chef/drift.ts` findings: `merged-open` closes the issue, `review-without-pr` reopens it, `stale-in-progress` links a pull request or is ignored | routine (0.85) |
| `escalate` | AGENTS.md "Parallel runs": a stronger model for a defect that survived two corrections | routine (0.85) |
| `criteria-binary` | Definition of Ready: every acceptance criterion is binary and names its check | routine (0.85) |
| `verification-exact` | Definition of Ready: Verification gives exact commands runnable from the repository root | routine (0.85) |
| `unanswered-question` | Definition of Ready: no open or deferred question remains | routine (0.85) |
| `premise-stale` | The readiness pass: an issue whose named files, symbols, or issues are gone no longer matches the repository | routine (0.85) |
| `already-done` | The readiness pass: merged pull requests or current code already deliver the acceptance criteria | routine (0.85) |

`scripts/chef/jev-predicates.test.ts` keeps this table equal to the registry.

## Owner instructions outrank process rules

An explicit owner instruction in the current scope outranks process rules and guards: the repeating-class guard, the three-round review cap, the context ceiling's advice, and grooming gates. Once the owner has said to merge a pull request, a guard firing on it is not a conflict to put back to them.

- A guard stops the worker and hands the case to the coordinator. The coordinator decides on the evidence and the owner's instruction, records the decision and the waived guard in its log and on the pull request, and files any reassessment of the repeating class as a follow-up issue.
- **A red main-health.** It is a warning in the merge report and never a refusal, so no waiver exists and none is needed. The owner's standing rule that load-flaky tests never gate still holds: fix the flake's mechanism, and do not let it hold up a merge.
- The coordinator asks the owner only about what is reserved for them: irreversible or outward-facing actions, security and credentials, anything the owner reserved by name, and real conflicts between two owner instructions. A conflict between an owner instruction and a process rule is none of these, so the coordinator does not ask.
- **Relays.** A coordinator never asks the owner to repeat themselves in another session. If an action needs the owner's own words in a particular session and that session cannot act on a relayed message, the coordinator does the work itself or through its own Agent-tool workers. If neither can, it says once, plainly, what is blocked and why.
- **Agent-tool workers.** The app does not start sessions from a turn woken by another session's message, or over Remote Control. When starting new sessions is not possible, the default dispatch is native Agent-tool workers, which need no click from the owner.

## Asking the owner

When Jev does not decide an owner decision, ask the owner directly with a recommendation. In Claude Code, use `AskUserQuestion`: two to four genuinely comparable options per question, the recommended option first with "(Recommended)" in its label, and each description stating the consequence for this codebase, with Jev's probabilities in the description of the options they rate. In Codex, ask the same question directly in the conversation, in that shape. A subagent or worker cannot ask: it returns the question and its recommendation to the coordinator, which asks. Keep working on packages that do not depend on the answer. Never park a decision in a ticket; see [the Linear policy](linear-policy.md).

Ask the questions the readiness pass surfaces in one batch before dispatch, as `SKILL.md` "Understand the work" describes, rather than one at a time as workers reach them.

## Recording

`jev.ts` appends every call to `<main checkout>/tmp/chef/jev-decisions.jsonl` (override with `--record <jsonl>`), storing a SHA-256 of the state and never the state itself. Every owner choice that Jev decided also gets two records, so the owner can audit it later: a line in the work-history log (`bun scripts/chef/note.ts log <note> --file <entry>`) giving the question, the answer, the probability, the model, and the threshold, and a comment with the same facts on the issue or pull request the choice affects. A routine call that Jev decided needs the log line; add the comment when it changed the shape of the delivered work.
