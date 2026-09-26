# Worker revision realm pool

Status: accepted. This is architecture decision 0004, building on 0003.

## Context

ADR 0003 (COR-117) proved the revision realm lifecycle, ready-manifest validation, and the host/realm turn protocol envelope against a deterministic fake realm, and explicitly deferred "real Worker realm pooling, one pool per immutable revision, warming, and routing" to COR-249. Two of COR-117's own project criteria — "two revisions of one workflow execute concurrently in distinct realms" and "the old realm remains available for runs pinned to it" — could not be exercised without a real pool to test against.

## Decision

Build a real Bun `Worker`-backed revision realm (`WorkerRealm`) implementing the exact port `FakeRealm` already proved (`activate`, `dispatchTurn`, `beginDrain`, `terminate`, `crash`, `restart`), then a revision-scoped pool (`RevisionRealmPool`) and a `(name, revision)`-keyed registry (`RevisionRealmRegistry`) on top of it. Every module lives under `src/core/realm/`, next to 0003's lifecycle/protocol modules.

### One realm, one execution

`RealmLifecycle`'s transition table (0003) has no path back from `Active` to `Ready` — `activate()` fixes `workflowRevision`, `realmGeneration`, and `executionToken` for the realm's entire `Active` lifetime, and every subsequent turn's `turnId` increments against that fixed identity. This slice does not reopen that table (a coordinator decision already made), so `WorkerRealm` and `RevisionRealmPool` build around it rather than against it: one `WorkerRealm` instance serves exactly one execution end to end, and `RevisionRealmPool.releaseAfterExecution` drains and terminates it once that execution finishes rather than returning it to an idle `Ready` state for reuse. `acquireForExecution` takes an idle, already-`Ready` realm the pool warmed ahead of demand when one exists, or warms a fresh one, bounded by `concurrency`.

`RealmLifecycle` also has no direct exit to `Terminated` from `Warming` or `Ready` — only `Draining` reaches `Terminated`, and `Ready` can only reach `Crashed`. `WorkerRealm.discard()` (used by a pool reclaiming an idle, never-activated realm, and by a genuine Worker-level failure) routes through the nearest legal exit for whatever state the realm is actually in, rather than adding a new transition.

### A new host/realm wire protocol, layered on the existing handshake

`RealmTurnEnvelope` (0003) defines the four identifiers a turn must agree on; it does not define how a turn's `input`/`result`/failure actually cross the wire. This slice adds `RealmRunMessage` / `RealmResultMessage` / `RealmFailureMessage` (`worker-realm-messages.ts`) for exactly that — a small, opt-in envelope alongside the existing internal-Worker-realm `ready` handshake (WFT-28) and entirely separate from the generic `WorkerInboundMessage`/`WorkerOutboundMessage` protocol `WorkerExecutionStrategy` uses today. Neither existing protocol is touched.

### Learning a simulated revision's identity without `WorkerOptions.name`

The Worker spec's `WorkerOptions.name` is meant to become the spawned worker's own `self.name`, which would have let one shared test fixture script simulate several distinct revisions cheaply. Verified against Bun 1.4.2: Bun does not surface it. `WorkerRealm#spawnWorker` instead posts an explicit `realm-configure` message — carrying an optional `artifactDigest` — as the very first thing it ever sends, before the realm-ready handshake. A production bootstrap script has no use for this message (it derives its identity from its own build, one `workerUrl` per revision) and simply never listens for the type; the shared test fixture (`__fixtures__/revision-realm-worker-entry.ts`) waits for it before ever sending `ready`, so which "revision" a given Worker instance advertises is settled by an explicit message, not a timing assumption about module-scope evaluation order.

### Reference counting and activation routing

`RevisionRealmPool.activeRealmCount` (realms currently mid-execution) is wired into `WorkflowRevisionReferenceCounts.activeExecutionRealms` (`core/catalog/reference-counts.ts`, `core/engine/catalog-removal.ts`) through a new optional `EngineInternals.revisionRealmRegistry` field. No construction path sets this field, so every default engine keeps reading `0`, matching every existing consumer's behavior byte for byte.

`RevisionRealmPool.markInactive`/`markActive` and `RevisionRealmRegistry.markInactive`/`markActive` are the mechanism for "activation routes new starts only to the newly active revision; a run pinned to an older revision keeps executing in that revision's realm": `markInactive` refuses a further `acquireForExecution` for that revision (a _new_ start), while leaving any realm already mid-execution running untouched — it self-releases through `releaseAfterExecution` when its own execution finishes, at which point, if the revision is still inactive, the pool is fully drained and the registry reclaims it entirely ("a drained realm with no pinned work terminates and cannot emit an accepted late result" — a realm's own `#acceptRealmMessage` already refuses any message once it is not `Active`, regardless of why).

This slice does **not** wire a live `Engine`'s `catalog:revision-draining`/`catalog:revision-activated` events to these two methods — that requires deciding how an `Engine` opts into revision realms at all (a new `workflowExecutionMode` variant or option, threaded through `construction.ts`), which is future integration work, not a mechanism this ADR's scope can leave unproven. `markInactive`/`markActive` are the seam that wiring would call, proved directly at the registry level.

### Module-graph boundary

"The stable host never imports workflow implementation artifacts" is proved by static analysis (`revision-realm-module-boundary.test.ts`), not by running code: a `Bun.build()` bundle of `revision-realm-pool.ts`/`revision-realm-registry.ts`/`worker-realm.ts` must never contain a fixture workflow-implementation module's sentinel string, while a bundle of the realm-side worker bootstrap fixture — which legitimately imports it, the same way a real bootstrap imports real workflow code — must. Both directions are asserted; a bundle that never reaches the sentinel for the wrong reason (a typo, a dead import) would otherwise pass the negative assertions vacuously.

## Alternatives considered

Routing revision realms through the existing `WorkerExecutionStrategy`/`WorkerPool`/`WorkerExecutionDispatcher`/`WorkerFaultHandler` machinery was rejected. Those modules assume exactly one `WorkerPool` (`this.#dependencies.pool.acquire()`/`.release()`/`.discard()` throughout the dispatcher and fault handler), so serving several revisions through them would mean either widening every one of those call sites to route by revision — real risk to the default, unchanged `workflowExecutionMode: 'worker'` path this slice must leave untouched — or building a second, revision-aware routing layer beside them anyway. `ExecutionStrategy` (`core/execution-strategy.ts`) is explicitly documented as transport-agnostic and open to "a future out-of-process or remote workflow worker" implementing it, which is what a revision-realm-backed strategy will eventually be; this slice builds the realm/pool/registry mechanism that strategy would delegate to, without committing to its exact shape or to a new `workflowExecutionMode` value yet.

Reusing `WorkerPool` itself (revision-tagging its Workers) was rejected for the same reason ADR 0003 rejected deriving the lifecycle from one transport's incidental behavior: `WorkerPool` is a flat, revision-agnostic, reusable-worker pool by design (`acquireSpecificWorker`'s parked-generator-state precedent depends on that reuse); forcing it to also enforce "never place unrelated revisions in one Worker" would either weaken that invariant for its existing callers or require a parallel revision-check nobody could omit by construction, exactly the outcome a revision-scoped `RevisionRealmPool` gets for free by construction (its `workerUrl`/`expectedWorkflowTypes`/`expectedArtifactDigest` are fixed once, at the pool level).

## Consequences

- The default `workflowExecutionMode: 'worker'` path, `WorkerPool`, `WorkerExecutionStrategy`, `WorkerExecutionDispatcher`, `WorkerFaultHandler`, and `catalog-activation.ts` are all unchanged — this slice adds files under `src/core/realm/` and one optional field to `EngineInternals`, and nothing else.
- `activeExecutionRealms` reads a real signal once a host opts in, closing the last placeholder-`0` field `core/catalog/reference-counts.ts` still had from WFT-12/17/20/21 (only `pendingDispatches` remains a documented placeholder).
- A future slice that lets an `Engine` opt into revision realms end to end needs: a new `workflowExecutionMode` value (or equivalent option), construction wiring that creates a `RevisionRealmRegistry` and installs it on `EngineInternals`, a `catalog:revision-draining`/`catalog:revision-activated` listener calling `markInactive`/`markActive`, and a strategy (implementing `ExecutionStrategy`) that drives `RevisionRealmRegistry.acquireForExecution`/`dispatchTurn`/`releaseAfterExecution` from `startWorkflow`/`resumeWorkflow`/`cancelWorkflow`. None of that exists yet.
- COR-246 (Child-process Adapter) can implement the same port `WorkerRealm` and `FakeRealm` both expose over Bun IPC instead of a `Worker`, and share a conformance suite across all three once it exists.
- COR-113 (Crash, Cancellation, and Disposal Hardening) still owns letting an in-flight turn settle cooperatively during `Draining` (this slice's `WorkerRealm`/`RevisionRealmPool` reject rather than cooperatively complete a pending turn on drain/terminate, matching `FakeRealm`'s own documented scope boundary), and a memoized/idempotent host-side disposal promise above `RevisionRealmRegistry.dispose()`.
- COR-243 (Operational Integration) still owns realm diagnostics, a Console view, and `bun --watch`/`bun --hot` guidance.

## Verification

From `packages/weft`:

```bash
bun test src/core/realm
bun test src/core/worker-execution-strategy.test.ts
bun test src/workers/pool.test.ts
bun test src/core/engine/catalog-activation.test.ts
```

The last three are the existing default-path regression suites (generic Worker execution, `WorkerPool`, catalog activation); they pass unchanged, proving this slice's additions did not alter default behavior. From the repository root, `bunx turbo run typecheck lint test --filter=@lostgradient/weft` covers the whole package, and `bun run validate` is the repository-level gate for a full delivery.

## Remaining COR-249 (and COR-117) project criteria

This slice proves, with a real `Worker` rather than the fake realm: two revisions of one workflow executing concurrently in distinct realms, with genuinely concurrent in-flight turns proved by an explicit per-realm release barrier; distinct realm identity (each revision's realm rejects the other's envelope); a run pinned to an older, now-inactive revision keeping its realm; a drained realm with no pinned work terminating and being unable to emit an accepted late result; realm crash isolating sibling revisions; the stable host's own module graph never containing the workflow implementation, proved by static bundling with a positive control; and `activeExecutionRealms` reading a real, opt-in signal.

It does not build, and explicitly defers:

- Wiring a live `Engine` to create/own a `RevisionRealmRegistry` and route real `startWorkflow`/`resumeWorkflow`/`cancelWorkflow` calls through it — no new `workflowExecutionMode`, no `construction.ts` changes, no `catalog:revision-draining`/`catalog:revision-activated` listener. `markInactive`/`markActive`/`acquireForExecution`/`releaseAfterExecution` are the seam; nothing in this codebase calls them yet outside tests.
- A production revision bootstrap module / bundler pipeline that actually imports real workflow code per revision. This slice's fixture worker script stands in for that, exactly as `FakeRealm` stood in for a real Worker in 0003.
- Cooperative in-flight completion during `Draining`, and a memoized/idempotent disposal promise above the registry (COR-113).
- A child-process adapter and a Worker/child-process conformance suite (COR-246).
- Realm diagnostics, Console views, and `bun --watch`/`bun --hot` guidance (COR-243).
