# Decisions

Settle each choice with the cheapest authority allowed to settle it: the evidence first, then the owner. A choice the repository, the code, or an instruction already settles is decided from that evidence, and you say what was picked.

- A **routine call** is a choice inside the authorized scope (grooming depth, which of two compatible batchings to use, whether a failure is shared with the base). The coordinator makes it alone and records why in the log.
- An **owner decision** is a product, architecture, or scope choice. Deleting, publishing, spending, security and credential choices, and any approval boundary written in the request, an instruction file, or an issue are always the owner's.

## Owner instructions outrank process rules

An explicit owner instruction in the current scope outranks process rules and guards: the repeating-class guard, the three-round review cap, the context ceiling's advice, and grooming gates. Once the owner has said to merge, a guard firing on that change is not a conflict to put back to them.

- A guard stops the worker and hands the case to the coordinator, which decides on the evidence and the owner's instruction, records the decision and the waived guard in its log and on the change, and files any reassessment as a follow-up issue.
- The coordinator asks the owner only about what is reserved for them and about a real conflict between two owner instructions.
- A coordinator never asks the owner to repeat an instruction in another session. When a session cannot act on a relayed message, the coordinator does the work itself or through its own Agent-tool workers, which need no click from the owner; when neither can, it says once what is blocked and why.

## Asking the owner

Ask directly, with a recommendation. On Claude Code use `AskUserQuestion`: two to four comparable options, the recommended one first with "(Recommended)" in its label, each stating its consequence for this codebase. On Codex ask the same question in the conversation. A worker cannot ask: it returns the question and its recommendation to the coordinator. Ask the readiness pass's questions in one batch before dispatch, keep working on what does not depend on the answer, and never park a decision in a ticket ([the Linear policy](linear-policy.md)).
