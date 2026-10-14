# Durable Steering Log

This is the design for making a durable Bureau session's steering survive any number of restarts and any number of Bureau processes sharing one backend. It replaces the steering mailbox as the durable record of steering. That mailbox carried steering across exactly one restart, because recovery acknowledged what it replayed. A first attempt in pull request 190 added a desired-state snapshot, command records, and a lease beside the mailbox. Four review rounds kept finding races between those separately written stores, so that work was backed out. This design keeps one durable structure and commits every change to it atomically.

## The core idea

The steering gate stays the in-memory authority a run reads at its step boundaries. Its durable form becomes a per-session-incarnation, append-only log of events, each carrying the inputs it was decided from. Gate state in any process is a fold of that log.

Admitting a steering command depends on facts only the admitting process has: which runs are live (run binding and `run-ambiguous`), the agents map, catalog validation, and the clock against a deadline. Replaying the raw request elsewhere could decide differently. So the log stores each event with those inputs, after Bureau-level validation has already resolved the command, and every process folding it decides identically.

## Storage layout

Everything lives in `runtime.kv`, which is a `ConditionalTextValueStore`. Its `conditionalBatch` is atomic across keys on the memory, SQLite, and LMDB backends, with per-key expected values and `null` for "must not exist". Per session incarnation:

- `steering-log:v1:<session>:<incarnation>:head` holds `{ sequence }`, the latest sequence number.
- `steering-log:v1:<session>:<incarnation>:entry:<zero-padded sequence>` holds one event.
- `steering-log:v1:<session>:<incarnation>:key:<principal>:<id>` marks each idempotency key the log bound, so deletion can find them.
- `steering-key:v1:<principal>:<id>` holds `{ sessionId, incarnation, sequence }`, the bureau-wide idempotency binding. Its scope matches the in-memory ledger.

`FleetEventFeed` was considered and rejected as the carrier. Its sequence is global rather than per session. A failed caller-supplied condition surfaces as 25 retries and then a generic error rather than a typed conflict. And `retain()` and workflow purges delete history, which a log that is the only durable copy of steering state cannot tolerate. The session outbox was rejected because it is consumed and deleted on acknowledgement, the same flaw as the mailbox.

## Appending

Every append is one `conditionalBatch` with these conditions and writes:

- **Head condition:** the head still equals the value this process last read. This is optimistic concurrency per session, with no lease.
- **Binding condition (admissions only):** the idempotency key is unbound, or still holds the stale binding of a deleted incarnation being replaced.
- **Writes:** the entry, the new head, and for admissions the binding and its marker.

A lost append means another process appended first. The process catches up by folding the new entries, then decides again from the caught-up state.

## Events, and how the fold stays deterministic

The gate is not rewritten. Each event records the inputs one of its existing methods needs, and folding calls that method with them:

- **`admit`:** the command (already validated and resolved against the agents map, catalog, and policy), the admitting process's live run ids, and its clock reading. Replayed as `gate.admit(command, { liveRunIds, now })`.
- **`applied`:** a run observed a `configVersion` at its boundary. Replayed as `gate.recordApplied(runId, configVersion, now)`.
- **`promoted`:** a run started. Replayed as `gate.promoteForNewRun(runId, now)`.
- **`run-ended`:** a run reached a terminal state. Replayed as `gate.failAcceptedForRun(runId, now)`.

While mutating, the gate reads no other process-local state; its only direct clock read is in a read-only accessor. So the same log folds to the same state, ledger, and command states in every process. Logging recorded inputs replaced the planned `decide`/`apply` split, which would have rewritten the gate for the same result.

Every event is appended first and applied only after the append succeeds, so the local gate changes in exactly the log's order. That includes run-boundary events (`applied`, `run-ended`), which the run's listener queues behind any admission in flight rather than applying at once. An earlier version applied them locally first, on the theory that they commute with a racing foreign admission. Review disproved that: an `applied` that lands locally before a racing supersession leaves the command `applied` here but `superseded` everywhere else. A run does not need its own boundary event immediately, because per-run applied tracking lives in the run's state. A failed boundary append is reported as a `steering` diagnostic.

Each durable gate also folds into its own ledger rather than the bureau-wide one. The fold must depend on the log alone, and a shared in-memory ledger can still hold entries for a session another process has deleted. Cross-session idempotency comes from the durable key bindings instead. A key bound in another session is answered by folding that session's log into a throwaway gate.

Each admission attempt reads live runs and the clock when it is decided, not when it was queued, so a run that ended (and logged it) meanwhile is never bound.

A refused admission (`rejected` or `unsupported-capability`) is logged like any other, so its id stays decided: an exact retry gets the original refusal back, and a mismatched one is a `conflict` against it. That includes refusals Bureau makes before the gate — an agent outside the agents map, an unknown policy profile or coordinate, a model outside the catalog — which are logged as `refused` events carrying their outcome, so a later retry is not re-judged against a catalog or policy that has since changed. Only caller-supplied ids are logged this way; a generated id can never be retried.

## Recovery and growth

Recovery is a fold from the first entry. It happens on first use in a process, and the gate catches up again before every admission and run start.

A durable run recovered after a crash steers like a fresh one. The awaited recovery hook folds the session's log before replay resumes, and hands the run its view of the gate. It also registers the same boundary and end listeners a fresh run gets, so the run picks up steering logged before the crash and logs what it applies. Before this design, a recovered run had no gate at all.

There is no checkpoint: a checkpoint of desired state alone would not restore the ledger that idempotency answers from, so checkpoints wait until a session's steering history is long enough to matter. A log grows with its session's steering activity and is deleted with the session.

A process can die after a session's deletion commits but before its log is deleted. A boot-time sweep removes any log whose session incarnation no longer exists. It is safe across processes because logs are keyed by incarnation, so a live session's log (in any process) is never touched.

## What changes outside the gate

- **The steering mailbox is retired.** AB-67's decision record chose it as "a projection of the same mailbox envelope/receipt contract". This design reverses that choice. `runtime-contracts.md` now points here, and no compatibility shim is added, per the pre-release policy.
- **Deletion is incarnation-scoped:** it removes `steering-log:v1:<session>:<incarnation>:*` and each binding that still points at that incarnation. A recreated session has a new incarnation and never sees the old log.
- **A paused run survives another process's deletion of its session.** Deletion settles only the deleting process's gate, and a paused run writes nothing, so Weft's cross-process cancel would never reach its waiter. The same 2-second poll that folds the log checks that the session incarnation still exists, and releases the gate's paused runs when it does not, as local deletion does (decided 2026-10-14). The released run's terminal session save is fenced to its incarnation, so it never recreates the deleted session.
- **Run liveness is backend-wide.** Every durable `agentRun` workflow Bureau starts is tagged with a hash of its session id and incarnation (`steeringSessionRunTag`; Operative's durable routing now accepts launch `tags`). The tag fits Weft's tag size limit for any session id, and a deleted session's still-running workflows never count as live for a recreated one. Durable admission takes a session's live runs from that tag across every process sharing the backend, together with this process's own registry. It records the result in the `admit` event, so a `pause` or `resume` binds to, or is `run-ambiguous` against, runs in any process. A run counts from its own `promoted` entry, before its workflow exists: until the engine knows it, and for at most 60 seconds after promotion, every promoted run without a `run-ended` is live, so concurrent starts on one session are each counted. A run's terminal session save applies only to the incarnation it started or recovered against, so a session deleted by another process mid-run is never recreated by that run.
- **Cross-process reach:** a run reads its own process's gate. That gate folds new entries before each admission and run start in its process, and, while the process drives any of the session's durable runs, every 2 seconds (decided 2026-10-14). A command admitted in another process therefore reaches a running run within about 2 seconds, at its next step boundary, and a remote `resume` releases a run waiting on its pause.

## Known limits

- **A run that dies with its process and is never recovered logs no `run-ended`.** A recovered run logs it when it ends, but one that recovery cancels or never claims leaves its `pause` `accepted` in the log, so an exact retry of that pause replays `accepted`. No live run reads it, so nothing stays paused. The log cannot tell a dead process's run from a live run in another process, so this design does not synthesize the event.
- **A boundary event that cannot be logged is dropped.** If logging `applied` or `run-ended` fails after its retries, or the store fails, the event is not applied anywhere: the local gate never holds state the log lacks. Until a later boundary event is logged, the affected commands keep their prior state, and a pause bound to a run that ended stays recorded until a `run-ended` for that run is logged. A `steering` diagnostic reports each dropped event.
- **A corrupt key binding is left in place.** Session deletion skips a binding it cannot parse rather than aborting its cleanup. Every later admission of that `(principal, id)` then fails closed on it until an operator removes it.

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
- **Corruption fails closed:** a malformed head, entry, or key binding fails recovery with an error instead of folding from defaults.
- **Deletion is incarnation-scoped:** delete-then-recreate under the same id never sees, and never deletes, the other incarnation's log.
- **Every new test is checked against the pre-change sources:** it must fail there for the reason it names.

Verification commands, both exiting 0:

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/bureau --filter=@lostgradient/weft
```

```bash
bun run format:check
```
