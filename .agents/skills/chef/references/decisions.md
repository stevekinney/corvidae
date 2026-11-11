# Decisions

Read this when a run meets a choice that the evidence does not settle.

Settle each choice with the cheapest authority allowed to settle it: the evidence first, then the owner. A choice the repository, the code, or an instruction already settles is decided from that evidence, and you say what was picked. The owner is not consulted for an answer that is already written down.

- **routine call**: a choice inside the authorized scope that the coordinator makes alone (grooming depth, which of two compatible batchings to use, whether a failure is shared with the base). Record why in the log.
- **owner decision**: a product, architecture, or scope choice that is genuinely the owner's. Irreversible or outward-facing actions (deleting, publishing, spending), security and credential choices, and anything the owner reserved, including an approval boundary written in the request, an instruction file, or an issue, are always the owner's.

## Owner instructions outrank process rules

An explicit owner instruction in the current scope outranks process rules and guards: the repeating-class guard, the three-round review cap, the context ceiling's advice, and grooming gates. Once the owner has said to merge a pull request, a guard firing on it is not a conflict to put back to them.

- A guard stops the worker and hands the case to the coordinator. The coordinator decides on the evidence and the owner's instruction, records the decision and the waived guard in its log and on the pull request, and files any reassessment of the repeating class as a follow-up issue.
- **A red main-health.** It is a warning in the merge report and never a refusal, so no waiver exists and none is needed. The owner's standing rule that load-flaky tests never gate still holds: fix the flake's mechanism, and do not let it hold up a merge.
- The coordinator asks the owner only about what is reserved for them: irreversible or outward-facing actions, security and credentials, anything the owner reserved by name, and real conflicts between two owner instructions. A conflict between an owner instruction and a process rule is none of these, so the coordinator does not ask.
- **Relays.** A coordinator never asks the owner to repeat themselves in another session. If an action needs the owner's own words in a particular session and that session cannot act on a relayed message, the coordinator does the work itself or through its own Agent-tool workers. If neither can, it says once, plainly, what is blocked and why.
- **Agent-tool workers.** The app does not start sessions from a turn woken by another session's message, or over Remote Control. When starting new sessions is not possible, the default dispatch is native Agent-tool workers, which need no click from the owner.

## Asking the owner

Ask the owner directly with a recommendation. In Claude Code, use `AskUserQuestion`: two to four genuinely comparable options per question, the recommended option first with "(Recommended)" in its label, and each description stating the consequence for this codebase. In Codex, ask the same question directly in the conversation, in that shape. A subagent or worker cannot ask: it returns the question and its recommendation to the coordinator, which asks. Keep working on packages that do not depend on the answer. Never park a decision in a ticket; see [the Linear policy](linear-policy.md).

Ask the questions the readiness pass surfaces in one batch before dispatch, as [coordination](coordination.md#understand-the-work) describes, rather than one at a time as workers reach them.
