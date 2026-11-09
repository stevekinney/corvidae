## Brief

<!-- A few sentences: the outcome this issue delivers and why it matters, so the worker can judge the cases nobody listed. -->

## Current behavior

<!-- What the code does today, with `file:line` evidence or a probe. Mark each claim "verified" (with the evidence) or "assumed", so the worker checks the assumed ones first. -->

## Acceptance criteria

<!-- AC1, AC2, …: each binary and naming how it is checked (a test or a command). A bug's criteria include the test that fails before the fix; add a criterion for anything that must keep working. These are the requirements; there is no separate list. -->

## Decisions

<!-- Every choice already made, with its source: a COR decision, a dated revision, or the owner's answer during drafting. An unanswered question means the issue is not Ready. -->

## Out of scope

<!-- What the worker must not change, with the COR issue that owns it when one exists. -->

## Constraints

<!-- Binding limits only: compatibility that must hold, known traps, and any one-way door (persisted format, wire protocol, published export). -->

## Files

<!-- Starting points as code spans, one per line, so `brief.ts` hands them to the worker. Hints, not a fence: line numbers go stale. -->

## Verification

<!-- Exact commands, defaulting to AGENTS.md "Gate on local checks": `bun test` on the touched files, `bun run lint:root`, `bun run typecheck:root` when root or `scripts/` files change, `bunx turbo run lint typecheck --filter=<workspace>`, and `bunx prettier --check` on the changed files. -->

## Delivery boundary

<!-- The artifact that ends the work: normally a merged pull request; a publication or deployment when one is required. -->
