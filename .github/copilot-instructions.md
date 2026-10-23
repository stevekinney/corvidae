# Review guidance

This is a pre-1.0, internal-only Bun and Turborepo workspace. The full policy is the "Review guidelines" section of `AGENTS.md`.

Before posting a finding or suggesting a change, read the linked COR issues and search Linear's COR backlog for the affected behavior, symbols, and proposed work, including other projects. Verify plausible matches against their scope, status, acceptance criteria, and decisions. Cite an existing ticket's identifier and link instead of duplicating its request or requiring unrelated work in this pull request. A ticket does not excuse a concrete blocker introduced by the diff; explain why that failure must be fixed before merge. If Linear is unavailable, disclose the incomplete lookup without treating it as a merge blocker or claiming no match exists.

Breaking changes are acceptable during pre-release. Do not request compatibility wrappers, deprecation periods, or retention of obsolete APIs to preserve prior behavior. Update affected in-repository callers directly and remove deprecated code in the replaced path. Continue checking persisted data, wire protocols, and published contracts for concrete defects.

Comment only when you can state a concrete failure: the inputs or interleaving, a supported configuration, and the wrong durable result. Flag:

- Correctness or data loss, including state written or exposed before its durable commit, or a post-commit failure swallowed with no repair.
- Check-then-act without a fence on the state it read; cleanup or settlement bound to a stale generation or round.
- A retry or replay that performs a different operation than its receipt records.
- Missing authorization on a new route or lookup; unvalidated input at an exported boundary.
- Fields or parts dropped across an adapter, projection, or wire mapping.
- One-way doors: persisted formats or schemas, wire protocols, published exports or specs.

Block only on demonstrated correctness risks and their concrete consequences. Touching a one-way door or making a deliberate breaking change is not itself a blocker. Omit nitpicks and optional refactoring suggestions.

Never comment on:

- Lines this pull request did not change, or behavior already on `main`.
- Anything `bun run lint`, `bun run format:check`, or the type checker enforces, including the ban on synchronous `.resolves`/`.rejects`.
- Scenarios that need an unsupported configuration, a hostile in-process caller, or an interleaving that a lease or claim already fences out.
- Behavior a linked COR issue or decision document specifies; cite it and stop.
- Style, naming, documentation wording, speculative hardening, compatibility shims, or missing CI, publishing, or Git hooks (the repository intentionally has none).

On a re-review, comment only on lines changed since your last review, and only on a regression they introduced or a one-way-door defect. Never re-raise a finding the author answered. One comment per defect class, at most six per review.
