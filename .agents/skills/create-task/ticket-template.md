## Objective

<!-- One or two sentences: the outcome this issue delivers and who or what benefits. -->

## Context

<!-- Why this matters now: the current behavior, the problem it causes, and any linked COR issue or decision. -->

## Requirements

<!-- R1, R2, …: what must be true when the work is done, one requirement per line. -->

## Acceptance Criteria

<!-- AC1, AC2, …: how each requirement is observed; every criterion is binary and checkable by a command or a named manual check. -->

## Scope

### In scope

<!-- The workspaces, files, and behaviors this issue changes. -->

### Out of scope

<!-- Nearby work this issue deliberately leaves alone, with the COR issue that owns it when one exists. -->

## Files

<!-- Repository paths as code spans, one per line, so `brief.ts` hands them to the worker. -->

## Constraints

<!-- Binding prohibitions: what must not change, compatibility that must hold, and any one-way door (persisted format, wire protocol, published export). -->

## Verification

<!-- Exact commands, defaulting to AGENTS.md "Gate on local checks": `bun test` on the touched files, `bun run lint:root`, `bun run typecheck:root` when root or `scripts/` files change, `bunx turbo run lint typecheck --filter=<workspace>`, and `bunx prettier --check` on the changed files. -->

## Delivery Boundary

<!-- The artifact that ends the work: normally a merged pull request; a publication or deployment when one is required. -->

## Open Questions

<!-- Questions only the owner can answer, or "None". -->

None
