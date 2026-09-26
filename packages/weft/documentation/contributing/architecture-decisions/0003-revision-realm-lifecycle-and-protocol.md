# Revision realm lifecycle and protocol

Status: accepted. This is architecture decision 0003.

## Context

Weft's existing `workflowExecutionMode: 'worker'` path (WFT-28) already isolates workflow execution in a Bun `Worker` and validates a one-time `ready` handshake ([`WorkerRealmReadiness`](../../../src/core/worker-realm-readiness.ts)) before dispatching turns. That path has no concept of an immutable _revision_: every pooled Worker is interchangeable, there is one flat `WorkerPool`, and a realm cannot be pinned to — or reclaimed with — one specific workflow build.

`Weft: Workflow Revision Isolation and Lifecycle` (COR-117 and its sibling issues) asks for realms scoped to one immutable artifact revision, so two revisions of a workflow can run concurrently, a drained revision's realm can be reclaimed exactly, and activation can route new starts to the new revision while old runs keep executing against the realm they started on. Building real Worker pooling and a child-process adapter first, without first pinning down the lifecycle and protocol both would need to obey, risks baking transport-specific assumptions into what should be a transport-independent contract.

## Decision

Define the realm lifecycle, the ready-manifest validation revision realms need beyond the existing handshake, and the host/realm turn protocol envelope as three small, transport-independent modules, proven against a deterministic fake realm before any real Worker or child-process adapter exists.

Revision realms are **opt-in** within the existing Worker execution mode. Every module added or changed in this slice defaults to the existing behavior when the new, opt-in dependency is omitted:

- The default (`workflowExecutionMode: 'worker'`) path used by `applications/chat-room` and `applications/desktop` is unchanged. `WorkerRealmReadiness` still validates only per-workflow-type contracts unless a caller supplies `getExpectedArtifactDigest`.
- Nothing in this slice touches `WorkerPool`, `WorkerExecutionStrategy`, or the wire messages a real Worker sends today.

### Lifecycle

[`RealmLifecycle`](../../../src/core/realm/realm-lifecycle.ts) is a pure state machine with no dependency on `Worker`, sockets, or processes:

```text
Warming --markReady(ok)-->   Ready
Warming --markReady(fail)--> Crashed
Ready   --activate()-->      Active
Active  --beginDrain()-->    Draining
Active  --crash()-->         Crashed
Draining--terminate()-->     Terminated
Draining--crash()-->         Crashed
Crashed --restart()-->       Warming   (bounded, only when referenced)
```

`Ready` can also crash directly (a realm that finished its handshake but has not yet been handed a workflow can still lose its underlying process). `Terminated` has no outbound transition. Every named method throws `RealmLifecycleTransitionError` when called from a state that does not permit it, so an illegal transition (for example `activate()` while `Draining`) is a thrown error, not a silently ignored no-op. `restart()` is the one method that returns a result instead of throwing when refused (`{ ok: false, reason: 'unreferenced' | 'restart-budget-exceeded' }`), because "nothing references this revision" and "the restart budget is spent" are ordinary business outcomes, not programming errors.

### Ready-manifest validation

[`validateRealmReadyMessage`](../../../src/core/worker-realm-readiness.ts) is `WorkerRealmReadiness`'s existing handshake check, extracted into a standalone pure function so it can be reused by something that is not itself a `Map<Worker, ...>`-keyed pool (the fake realm). It gained one new, optional dependency: `getExpectedArtifactDigest`. When a caller supplies it, the realm's reported `manifest.deployment.artifactDigest` (already computed by [`buildInternalRealmManifest`](../../../src/worker/manifest/internal-realm.ts)) must equal it exactly, or the handshake fails and the realm is rejected before it can enter `Ready` — closing the gap the COR-117 audit found: a realm whose per-workflow-type contracts happened to match could previously still be accepted on a different overall build. Every existing caller omits this dependency, so the default path's behavior is unchanged.

### Protocol envelope

[`RealmTurnEnvelope`](../../../src/core/realm/realm-protocol.ts) carries the four identifiers a revision realm's turn (and its result) must agree with the host on: `workflowRevision`, `realmGeneration`, `executionToken`, and `turnId`. `validateRealmTurnEnvelope` compares a received envelope against what the host expects and returns the first mismatching field, in a fixed order, so a message disagreeing on more than one field is always reported the same way. This is a new envelope for the opt-in revision-realm path — it does not replace or extend the existing generic Worker protocol's inbound/outbound message shapes in [`worker-protocol.ts`](../../../src/core/worker-protocol.ts).

The fencing runs in both directions. [`FakeRealm.dispatchTurn`](../../../src/core/realm/fake-realm.test-support.ts) validates a host-to-realm dispatch against the realm's fixed per-generation activation identifiers and the next expected `turnId` before creating a pending turn. [`FakeRealm.acceptResult`](../../../src/core/realm/fake-realm.test-support.ts) validates a realm-to-host result the same way, against the specific pending turn's own stored envelope (not merely its `turnId`): a result whose `workflowRevision`, `realmGeneration`, or `executionToken` disagrees throws the same `RealmEnvelopeMismatchError` the dispatch direction rejects with, and the pending turn is left outstanding rather than resolved with someone else's answer. This is what rejects a slow or stale realm's answer to a turn the host already gave up on — for example a result from a `realmGeneration` that crashed and was replaced, arriving after a fresh turn happens to reuse the same `turnId` post-restart.

### Fake realm

[`FakeRealm`](../../../src/core/realm/fake-realm.test-support.ts) drives all three modules together with no real Worker: it runs the ready handshake, tracks its own `RealmLifecycle`, and holds pending turns in a private map keyed by `turnId`. Every state change happens synchronously in response to a method call, so tests observe transitions and rejections directly rather than by polling or waiting on a timer. The port it exposes — `sendReady`, `activate`, `dispatchTurn`, `acceptResult`, `beginDrain`, `terminate`, `crash`, `restart` — is what COR-249's real Worker realm and COR-246's child-process realm are expected to implement against the same lifecycle and protocol modules, so a later shared conformance suite (COR-246's own scope) can run the same assertions against all three.

This slice's fake realm gates every message — including a result for a turn that was legitimately dispatched — on the realm currently being `Active`. A `Draining` realm therefore already refuses everything, matching the discard behavior it shares with `Terminated`. Because no turn dispatched before `beginDrain()` can ever be legitimately accepted after that point, `terminate()` rejects every turn still pending at that moment, the same way `crash()` does — otherwise the caller's `dispatchTurn()` promise would stay unsettled forever, a hang on an ordinary shutdown rather than only on a crash. Letting an already-in-flight turn settle cooperatively (resolve successfully instead of being rejected) while `Draining` is real future behavior, but building it now would be scope creep beyond what this slice's acceptance criteria require; it belongs to COR-113 (Crash, Cancellation, and Disposal Hardening).

## Alternatives considered

Building the real Worker realm pool (COR-249) first and deriving the lifecycle from its implementation was rejected: a lifecycle discovered by generalizing from one transport risks encoding that transport's incidental behavior (for example, whatever a Bun `Worker`'s own error events happen to look like) as if it were a required state, rather than the transport-independent contract both adapters must honor.

Reusing the existing generic Worker protocol's message shapes for the new envelope, rather than defining `RealmTurnEnvelope` separately, was rejected because that protocol has no `executionToken` or `realmGeneration` concept and is not scoped to one immutable revision; overloading it would either add fields the default path never uses or force every existing message through a stricter shape it does not need.

## Consequences

- The default `workflowExecutionMode: 'worker'` path and its consumers (`applications/chat-room`, `applications/desktop`) are unaffected: every new dependency is optional and unused by them.
- COR-249 (Worker Realm) can build a real, revision-keyed `WorkerPool` wrapper against `RealmLifecycle` and `RealmTurnEnvelope` directly, and reuse `validateRealmReadyMessage`'s `getExpectedArtifactDigest` hook rather than inventing a second digest check.
- COR-246 (Child-process Adapter) can implement the same port `FakeRealm` exposes over Bun IPC, and share a conformance suite against both real adapters once it exists.
- COR-113 (Crash, Cancellation, and Disposal Hardening) owns letting an in-flight turn settle cooperatively during `Draining`, and giving `WorkerExecutionStrategy`'s own dispose path the memoized-promise idempotency `RealmLifecycle` does not itself provide.
- COR-243 (Operational Integration) owns realm diagnostics, a Console view, and the `bun --watch`/`bun --hot` production guidance; none of that exists yet.
- `reference-counts.ts`'s `activeExecutionRealms` field (COR-117's assigned coordinator seam) stays at its documented placeholder `0` until COR-249 gives a real Worker realm a revision identity this accounting can count against — this slice intentionally does not wire live counting from the fake realm, since that would be dead plumbing with nothing real behind it.

## Verification

From `packages/weft`:

```bash
bun test src/core/realm/realm-lifecycle.test.ts
bun test src/core/realm/realm-protocol.test.ts
bun test src/core/worker-realm-readiness.test.ts
bun test src/core/realm/fake-realm.test.ts
bun test src/core/worker-execution-strategy.test.ts
```

The last command is the existing generic Worker-execution-mode regression suite; it passes unchanged, proving the opt-in additions did not alter default behavior. From the repository root, `bunx turbo run typecheck lint test --filter=@lostgradient/weft` covers the whole package, and `bun run validate` is the repository-level gate for a full delivery.

## Remaining COR-117 project criteria

This slice proves: ready-manifest validation including the artifact digest; wrong revision, realm generation, execution token, or turn ID rejection in both the host-to-realm dispatch direction and the realm-to-host result direction; a drained/terminated realm's inability to emit an accepted late result; a turn still pending at termination being rejected (not left hanging), the same way realm crash settles pending turns while isolating sibling realms; and bounded, reference-gated restart from `Crashed`. It does not build, and explicitly defers:

- Real Worker realm pooling, one pool per immutable revision, warming, and routing (COR-249).
- Two revisions of one workflow executing concurrently in distinct realms, and activation routing new starts only to the active revision, both of which need COR-249's real pools to exercise (COR-117's own remaining criteria; see its issue text).
- The old realm remaining available for runs pinned to it (also needs COR-249).
- A child-process adapter and a Worker/child-process conformance suite (COR-246).
- Cooperative in-flight completion during `Draining`, and a memoized/idempotent host disposal promise (COR-113).
- "Host disposal settles waiters, clears timers, and terminates realms exactly once" (COR-117's own acceptance criterion): this slice's fake realm settles its own pending turns on `crash()` and `terminate()`, and `RealmLifecycle.terminate()` throws rather than silently no-op-ing on a second call, so a fake realm cannot be terminated twice. But "host disposal" in that criterion names `WorkerExecutionStrategy`'s own dispose path — the real host-side timers and the memoized/idempotent disposal promise it needs — which does not exist yet and is explicitly COR-113's scope, not this slice's.
- Realm diagnostics, Console views, and `bun --watch`/`bun --hot` guidance (COR-243).
