# Durable Steering Log

This is the design for making a durable Bureau session's steering survive any number of restarts and any number of Bureau processes sharing one backend. It replaces the steering mailbox as the durable record of steering. Today that mailbox carries steering across exactly one restart, because recovery acknowledges what it replays. A first attempt in pull request 190 added a desired-state snapshot, command records, and a lease beside the mailbox. Four review rounds kept finding races between those separately written stores, so that work was backed out. This design keeps one durable structure and commits every change to it atomically.

## The core idea

The steering gate stays the in-memory authority a run reads at its step boundaries. Its durable form becomes a per-session-incarnation, append-only log of decided events. Gate state in any process is a fold of that log.

The log records decisions, not requests. Admitting a steering command depends on facts only the admitting process has: which runs are live (run binding and `run-ambiguous`), the agents map, catalog validation, the clock against a deadline, and `expectedRevision`. Replaying the raw command elsewhere could decide differently. So the admitting process decides once, and the log stores the outcome together with everything the fold needs to apply it with no local context.

## Storage layout

Everything lives in `runtime.kv`, which is a `ConditionalTextValueStore`. Its `conditionalBatch` is atomic across keys on the memory, SQLite, and LMDB backends, with per-key expected values and `null` for "must not exist". Per session incarnation:

- `steering-log:v1:<session>:<incarnation>:head` holds `{ sequence, checkpoint? }`, the latest sequence number and an optional folded checkpoint.
- `steering-log:v1:<session>:<incarnation>:entry:<zero-padded sequence>` holds one decided event.
- `steering-key:v1:<principal>:<id>` holds `{ session, incarnation, sequence }`, the bureau-wide idempotency index entry. Its scope matches the in-memory ledger.

`FleetEventFeed` was considered and rejected as the carrier. Its sequence is global rather than per session. A failed caller-supplied condition surfaces as 25 retries and then a generic error rather than a typed conflict. And `retain()` and workflow purges delete history, which a log that is the only durable copy of steering state cannot tolerate. The session outbox was rejected because it is consumed and deleted on acknowledgement, the same flaw as the mailbox.

## Appending

Every append is one `conditionalBatch` with these conditions and writes:

- **Head condition:** the head still equals the value this process last read. This is optimistic concurrency per session, with no lease.
- **Index condition (admission events only):** the idempotency key must not exist.
- **Writes:** the entry, the new head (advancing the checkpoint every N entries), and the idempotency key for admission events.

A lost append means another process appended first. The process catches up by folding the new entries, then decides again from the caught-up state. A key that now exists resolves as `replayed` or a typed `conflict` against the event it points to.

## Events

- **`admitted`:** the full command, plus the decided `configVersion`, the resolved `boundRunId` for pause and resume, the initial state (`accepted` or `applied`), whether it was a value no-op, and the `(principal, id)` keys it superseded.
- **`rejected`:** the command and its `SteeringCommandFailure`. It is logged so the idempotency key and the decision survive. A retry of a rejected id is `replayed` with the rejection, rather than decided afresh.
- **`transition`:** `(principal, id)`, the new state (`applied`, `failed`, or `superseded`), and the failure. Run-boundary transitions (`recordApplied`, deadline expiry at promotion, `failAcceptedForRun`) are appended asynchronously after the local gate has applied them, because those call sites are synchronous inside a run's step. A lost transition append is retried after catching up. Transitions are idempotent under the fold: applying `applied` to an already-applied command changes nothing.
- **`promoted`:** a run's start promoted the pending agent identity. This keeps `agentName` versus `pendingAgentName` deterministic in the fold.

## Gate refactor

`admit` splits into two steps:

- **`decide(state, command, context)`** returns an event. It is pure: no mutation and no promise side effects.
- **`apply(state, event)`** is deterministic and needs no process-local context.

The investigation found all rejection paths ahead of any mutation, so the split is mechanical apart from three points:

- `record()` derives the initial state from the applied floor, so `decide` computes it and the event carries it.
- Supersession sets come from the owner maps, so `decide` lists them and the event carries them.
- Releasing pause waiters is an in-process side effect. It stays outside `apply`, triggered by the local caller after an `apply` that unpauses.

`recordApplied`, `promoteForNewRun`, `failAcceptedForRun`, and `settleForDeletion` get the same treatment: compute the event, apply it locally, append it.

## What changes outside the gate

- **The steering mailbox is retired.** AB-67's decision record chose it as "a projection of the same mailbox envelope/receipt contract". That choice is what this design reverses, and the record and `runtime-contracts.md` (line 207) are updated to say so. No compatibility shim is added, per the pre-release policy.
- **Recovery is a fold.** On first use in a process, read the head, start from its checkpoint, and fold the entries after it. There is no claim, acknowledgement, or drain.
- **Deletion is incarnation-scoped:** it removes `steering-log:v1:<session>:<incarnation>:*` and the index keys whose entries point at that incarnation. A recreated session has a new incarnation and never sees the old log.
- **Cross-process reach is unchanged:** a run reads its own process's gate. A process folds new entries at the start of each run and before each admission, so steering admitted elsewhere reaches a run at its next boundary only if that run's process catches up. Steering does not push updates across processes.

## Run-scoped commands

`pause` and `resume` enter the log like every other target (decided 2026-10-14), each with its recorded `boundRunId`. All seven targets therefore share one admission path, and pause idempotency survives restarts and processes. A logged pause takes effect only where its bound run is live: the fold records the binding, and a process that does not hold that run never pauses anything for it. This replaces the earlier documented rule that run-scoped steering state is not carried across a restart.

## Acceptance criteria

Each of these is a test in `packages/bureau`:

- **Two crashes, then the same id:**
  - An exact retry is `replayed`.
  - A different target is a `conflict` (`target-mismatch`).
  - The same key in another session is a `conflict` (`session-mismatch`).
- **Desired state across restarts:** desired configuration and agent identity survive two restarts at the same `configVersion` the first process reported. The crash test asserts 2, not 1 or 4.
- **Two Bureaus on one SQLite file:**
  - Both can admit to the same session.
  - Each sees the other's commands after catching up, and `configVersion` is strictly increasing with no duplicates.
  - The same key submitted concurrently from both yields exactly one `accepted` and one `replayed` or `conflict`.
- **Durable transitions:** a command superseded or applied in one process replays with that state in another process, and after a restart.
- **Rejections are durable:** a rejected command's id, retried with a different value, is a `conflict`. It is never admitted.
- **Corruption fails closed:** a malformed head, entry, or index value fails recovery with an error instead of folding from defaults.
- **Deletion is incarnation-scoped:** delete-then-recreate under the same id never sees, and never deletes, the other incarnation's log.
- **Every new test is checked against the pre-change sources:** it must fail there for the reason it names.

Verification commands, both exiting 0:

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/bureau --filter=@lostgradient/weft
```

```bash
bun run format:check
```
