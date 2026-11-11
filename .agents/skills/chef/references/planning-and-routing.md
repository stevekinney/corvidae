# Planning and routing

Read this when writing the package table, sizing or batching work, choosing a model, or escalating a failing package.

## Work packages

Each package has a stable identifier, a binary outcome, the files or interfaces it may change, its dependencies with the evidence that releases each one, its batch, its model and effort with a reason, and its verification commands. Build an acyclic dependency graph and name the critical path. An implementation merge does not satisfy a publication edge: the published artifact releases adoption. Close each issue as its own gates pass, even while another batch is unfinished.

For a new Linear issue, use the `create-task` shape, check it against the Definition of Ready in [the Linear policy](linear-policy.md), and write it with `bun scripts/chef/linear.ts create --team <KEY> --title <t> --file <md> --label <name>`, which refuses a duplicate title. Reuse an existing issue instead of cloning it into a worker ticket.

## Design programmes

Work built from an agreed design (a Claude Design canvas, its boards, and its index rows) treats each row as a requirement.

- Save the canvas index board (`project/Main.dc.html`, read with the Artifact tool) under `tmp/chef/design/<canvas id>/` and run `bun scripts/chef/design-ledger.ts --index <file> --canvas <id>` before dispatch. Every row is a criterion in exactly the issue that builds it, or deferred on an issue with a reason (`Deferred: 19b, because …`). Exit 1 blocks dispatch; fix the issues, not the ledger.
- Run it again after every split or revision that moves rows.
- `brief.ts` carries the rows, and the worker returns a design-review verdict per row.
- Close the programme only after `design-ledger.ts` exits 0 and a full drift audit of the canvas against the shipped interface (the `design-review` skill) leaves no unexplained miss.

## Sizing and splitting

Size work by area, not by issue (owner decision, 2026-11-10). Tokens per changed line fall as a unit grows, from about 66K under 300 lines to 8K over 3,000, because a worker's fixed cost is reading its context. Cluster the issues of one area under one worker, target 500 to 2,000 changed lines per unit, and never split below about 300 lines. `focused-checks.ts` warns above 3,000 changed lines outside tests or 60 files.

Estimate each issue's size before dispatch: call sites per removed or renamed member, and test files touched. Over about 60 call sites or about 40 test files, split it into a core and design stage and a mechanical stage (the codemod and per-call-site sweep), with a handoff file from the start so the second worker begins from the first's decisions; the 300-line floor wins over this split. The mechanical worker greps the removed names across the repository, fixtures included, because other sessions keep landing code against the old surface.

## Batching

Batch work when it shares one repository, a cohesive change, compatible files, validation, and delivery boundary. Split cross-repository work and independently released artifacts, serialize overlapping files and shared contracts, and give concurrent edits separate worktrees.

## Models and effort

On Claude Code, Sonnet 5.5 implements (effort `high`), Opus 5.5 coordinates and is the primary reviewer (`xhigh`), Haiku 5.5 does bounded lookups and mechanically checkable volume (`low`), and Fable 5.1 is escalation only (`high`). On Codex the starting selections are:

| Work | Codex selection |
| --- | --- |
| Bounded lookup, inventory, deterministic verification | `gpt-5.6-luna`, low effort |
| Clear implementation with known interfaces and tests | `worker` / `gpt-5.6-luna`, medium effort |
| Broader investigation or integration | `gpt-5.6-terra` or `gpt-5.6-sol` where available, medium effort |
| Architecture, concurrency, security, final high-risk review | a relevant specialist or stronger model, high effort |

Fable is for a one-way door (a persisted format, wire protocol, authorization rule, or published surface), irreducible ambiguity, or a defect that survived two corrections. An implementer on Opus or Fable records its reason in the note at dispatch. On Claude Code pass `model` and `effort` on every dispatch, because defaults differ by model; on Codex pass `model` and `reasoning_effort`. A fixed role definition overrides both, and a dispatch result is not proof of what ran. Review by tier: a script for a pure move, the `chef-reviewer` for infrastructure, one-way doors, and anything that sets a template, and a second reviewer for the lock and concurrency infrastructure.

## Escalation

Escalate only the failing package. After two unsuccessful attempts at the same defect or acceptance criterion, stop patching, inspect the failure against a control, and reassess the causal model before another correction. The count belongs to the defect across agents and follow-ups, and a regression a correction introduces in the same module counts as another attempt. After the second, hand the class to the escalation tier for a design pass over the whole outcome space. A missing credential, owner, or external artifact needs that dependency resolved, not a larger model.

Concurrency, replay, retry, and state-machine work (finish reasons, run or settlement lifecycle, parks and suspends, recovery, shutdown, retries) needs an outcome matrix in the charter before dispatch: every input or failure crossed with every exit, each with its required result, written into the acceptance criteria and turned into a table-driven test that is red first. Every row carries the behavior on `main` today, from a test run or probe, and a row that changes it cites its source: an issue line, a dated revision, or a COR decision found by searching COR. A matrix written from the spec alone invents requirements. An escalation charter never includes merging `main`, resolving conflicts, or running `bun run check`; a cheaper tier does that after the design lands.
