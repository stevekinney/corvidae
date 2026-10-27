# Decisions and Jev

Read this when a run meets a choice that the evidence does not settle. `SKILL.md` keeps the summary; this file holds the thresholds, the command, its exit codes, how to ask the owner, how to record a decision, and worked examples.

An autonomous run still meets choices. Settle each with the cheapest authority that is allowed to settle it: the evidence first, then Jev, then the owner.

- **Jev**: TypeSafe AI's decision model. It returns probabilities for a yes/no, choice, or scale question, and it does not generate text. It needs `TYPESAFE_API_KEY`, resolved as in [credentials](credentials.md).
- **routine call**: a choice inside the authorized scope that the coordinator would otherwise make alone, such as whether a failure is shared with the base, which of two compatible batchings to use, or how much grooming an issue needs.
- **owner decision**: a product, architecture, or scope choice that is genuinely the owner's.

A choice that the repository, the code, or an instruction already settles is decided from that evidence, and you say what was picked. Neither Jev nor the owner is consulted for an answer that is already written down.

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

## What to send

`state` is a compact summary of the options and the evidence a careful colleague would need: what was observed, the exit codes or counts that matter, and what each option would cost or risk. Keep it to a few sentences or a short list. Never send secrets, credentials, tokens, environment values, or personal data. Do not paste logs or diffs; summarize them and cite the evidence path in the note instead. Use `--state-file <path>` when the summary is longer than a command line should hold, and write that file under `tmp/chef/` in the main checkout, never into the repository's tracked files.

## Running a decision

```bash
bun scripts/chef/jev.ts decide --kind routine --question "<question>" --state "<summary>" --yes-no
```

The result is the answer, its probability, the model, and whether it cleared the threshold. The script appends every call to `<main checkout>/tmp/chef/jev-decisions.jsonl` (override with `--record <jsonl>`), storing a SHA-256 of the state and never the state itself. Add `--json` to read the result programmatically.

- Exit 0: Jev decided, at or above the threshold. Act on the answer.
- Exit 1: the probability fell below the threshold. A routine call goes back to the coordinator, which decides from the evidence and records why. An owner decision goes to the owner.
- Exit 2: invalid usage. Fix the command; it is not an answer.
- Exit 3: Jev is unavailable (no credential, a 401, a 5xx or 529, or a network error; a 429 is retried once after the wait the response asks for). Skip Jev: routine calls go back to the coordinator, and owner decisions go to the owner, with no probabilities to show. Record in the note that Jev was skipped and why. Do not retry in a loop, and do not let the outage stall independent work.

## Owner instructions outrank process rules

An explicit owner instruction in the current scope outranks process rules and guards: the repeating-class guard, the three-round review cap, main-health refusals, the context ceiling's advice, and grooming gates. Once the owner has said to merge a pull request, a guard firing on it is not a conflict to put back to them.

- A guard stops the worker and hands the case to the coordinator. The coordinator decides on the evidence and the owner's instruction, records the decision and the waived guard in its log and on the pull request, and files any reassessment of the repeating class as a follow-up issue.
- **A red main-health from a load flake.** The owner's standing rule is that load-flaky tests never gate. When the failing test passes alone on a control commit of `main`, the coordinator waives the refusal with `merge-gate.ts` (or `deliver.ts`) `--waive-load-flake "<test>: <why it is load>" --control-head <full sha of the control>`. The gate records the waiver in `main-health.json` under `waivers` and prints it in its report. `--fixes-main` is only for the pull request that repairs `main`; never use it to waive a flake, because the health file's `fixes` would then name pull requests that fixed nothing. The waiver merges the pull request; fixing the flake's mechanism is still owed.
- The coordinator asks the owner only about what is reserved for them: irreversible or outward-facing actions, security and credentials, anything the owner reserved by name, and real conflicts between two owner instructions. A conflict between an owner instruction and a process rule is none of these, so the coordinator does not ask.
- **Relays.** A coordinator never asks the owner to repeat themselves in another session. If an action needs the owner's own words in a particular session and that session cannot act on a relayed message, the coordinator does the work itself or through its own Agent-tool workers. If neither can, it says once, plainly, what is blocked and why.
- **Agent-tool workers.** The app does not start sessions from a turn woken by another session's message, or over Remote Control. When starting new sessions is not possible, the default dispatch is native Agent-tool workers, which need no click from the owner.

## Asking the owner

When Jev does not decide an owner decision, ask the owner directly with a recommendation. In Claude Code, use `AskUserQuestion`: two to four genuinely comparable options per question, the recommended option first with "(Recommended)" in its label, and each description stating the consequence for this codebase, with Jev's probabilities in the description of the options they rate. In Codex, ask the same question directly in the conversation, in that shape. A subagent or worker cannot ask: it returns the question and its recommendation to the coordinator, which asks. Keep working on packages that do not depend on the answer. Never park a decision in a ticket; see [the Linear policy](linear-policy.md).

Ask the questions the readiness pass surfaces in one batch before dispatch, as `SKILL.md` "Understand the work" describes, rather than one at a time as workers reach them.

## Recording

Every owner choice that Jev decided gets two records, so the owner can audit it later. First, a line in the work-history log (`bun scripts/chef/note.ts log <note> --file <entry>`) giving the question, the answer, the probability, the model, and the threshold. Second, a comment on the issue or pull request the choice affects, with the same facts. A routine call that Jev decided needs the log line; add the comment when it changed the shape of the delivered work.

## Worked examples

A yes/no routine call: a repository gate failed in a file the candidate did not touch, and a control run produced counts.

```bash
bun scripts/chef/jev.ts decide --kind routine \
  --question "Is this test failure shared with the base commit, so it is not this change's blocker?" \
  --state "Candidate fails checkpoint-prune in 3 of 5 interleaved runs; the base commit fails it in 2 of 5 under the same load. The candidate does not touch that file or its dependencies." \
  --yes-no
```

The answer is the likelier side with that side's probability, and both probabilities are printed, so `no (p=0.98)` is a decision too. A `yes` at 0.85 or above records the failure as shared and continues to the delivery boundary; a `no` at 0.85 or above treats it as this change's blocker; below the threshold, widen the control before deciding.

A choice owner decision: two designs for an exported surface, which is a one-way door.

```bash
bun scripts/chef/jev.ts decide --kind owner \
  --question "Which shape should the new public export take?" \
  --state "Option flat: one function taking an options object, matching the three existing exports. Option builder: a chainable object, more flexible, no existing precedent in the package. The export is consumed by two applications and is hard to change once adopted." \
  --choice flat="One function taking an options object" \
  --choice builder="A chainable builder object"
```

At 0.9 or above for one key, take it and record it as above. Below 0.9, ask the owner with both probabilities shown, recommending the likelier key first.

A scale routine call: how much grooming the next issue needs before a worker takes it.

```bash
bun scripts/chef/jev.ts decide --kind routine \
  --question "How much up-front grooming does this issue need?" \
  --state "The issue names the files, has four binary acceptance criteria and the exact test command, and touches one workspace with no shared contract." \
  --scale none,light,full
```

The answer is the level with its probability. At 0.85 or above, use that level; otherwise decide from the evidence and record the choice.
