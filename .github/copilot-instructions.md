# Review guidance

This is a pre-1.0, internal-only Bun and Turborepo workspace under active prototyping. Move fast on stable infrastructure: be rigorous where a mistake is hard to undo and quiet everywhere else. The full policy is the "Review guidelines" section of `AGENTS.md`.

Flag, with a concrete failure scenario:

- Correctness bugs, data loss, races, stale or duplicate state transitions, and missing cleanup or rollback.
- Malformed input that is not rejected at the boundary that owns the contract.
- One-way doors: changes to persisted formats or schemas, wire protocols, or exported package surfaces that cannot be undone cheaply.
- A defect that is one instance of a recurring class. Name the class so it can be fixed once with a test, lint rule, or type constraint.

Stay quiet about:

- Style, naming, formatting, and anything `bun run lint` or `bun run format:check` already enforces.
- Speculative hardening, contrived edge cases, and extra abstraction in internal code that a later change can cheaply alter.
- Compatibility shims, adapters, or re-export layers; this repository does not want them before release.
- Missing publishing, CI/CD, or Git-hook setup; this repository intentionally has none; the mirror tooling lives in `stevekinney/corvidae-mirror`.

Review each pull request once, thoroughly. On later pushes, comment only on regressions the new commits introduced or serious defects on a one-way door. Prefer one comment per class of defect over one comment per instance.
