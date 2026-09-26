# Child-process revision realm

Status: accepted. This is architecture decision 0006, building on 0003, 0004, and 0005.

## Context

ADR 0004 (COR-249) built the first real revision realm transport, `WorkerRealm`, and explicitly deferred a second: "COR-246 (Child-process Adapter) can implement the same port `WorkerRealm` and `FakeRealm` both expose over Bun IPC instead of a `Worker`, and share a conformance suite across all three once it exists." ADR 0005 (R2E) then wired `RevisionRealmRegistry` into a live `Engine` for the Worker transport only. COR-246's own issue text: "Reuse the same protocol over Bun IPC with explicit startup, shutdown, and resource boundaries — stronger crash/resource containment than a Worker's shared-process heap, for untrusted or failure-prone workflow code."

## Decision

Build `ChildProcessRealm`, implementing the identical `activate`/`dispatchTurn`/`beginDrain`/`terminate`/`crash`/`restart` port `WorkerRealm` and `FakeRealm` already prove, driven by the same transport-independent `RealmLifecycle` and `RealmTurnEnvelope` modules 0003 built — over a real `Bun.spawn` IPC channel instead of a `Worker`. Extract a `RevisionRealm` interface (`src/core/realm/revision-realm.ts`) naming that shared port explicitly, and retype `RevisionRealmPool`/`RevisionRealmRegistry`/`RevisionRealmExecutionStrategy` against it instead of the concrete `WorkerRealm` class — the mechanical half of "share a conformance suite across all three."

### Transport selection, not a new option surface

`RevisionRealmConfig` (and `RevisionRealmPoolOptions`) gain one new field, `transport?: 'worker' | 'child-process'`, defaulting to `'worker'` when omitted — every existing caller's behavior is unchanged byte for byte. `workerUrl` doubles as the child-process transport's bootstrap script path rather than introducing a second, differently-named field: both transports speak the identical realm protocol, so one field naming "the bootstrap this pool spawns" is enough, and the two adapters differ only in a handful of transport-specific knobs (`smol` for Worker; `env` for child-process). `RevisionRealmPool` picks the concrete class at warm time; nothing above the pool (the registry, the execution strategy, the engine) branches on which transport backs a given realm.

### `Bun.spawn` IPC specifics

Bun's `ipc` option is only compatible with another `bun` instance as the child, so `ChildProcessRealm` spawns `[process.execPath, scriptPath]`, never a bare `'bun'` resolved from `PATH`. `stdout`/`stderr` are explicitly `'inherit'` rather than Bun's own `'pipe'` default — an unread pipe fills its OS buffer and blocks the child indefinitely, a real resource-boundary hazard rather than polish. `env` is an explicit, optional knob (omitted means Bun's own default of inheriting the host's environment, unchanged) rather than an unstated assumption, giving a caller a real sandboxing lever COR-246's "resource boundaries" language asks for.

Every process exit — a genuine crash, a lost-ack, or this realm's own self-initiated `.kill()` — fires `onExit`/`onDisconnect`, unlike a real `Worker`'s `error` event, which never fires merely because `.terminate()` was called. `#handleProcessDown` funnels both callbacks through the same idempotent-shutdown path `#isTerminalState()` already guards, so a self-initiated kill is a no-op there. A separate hazard `WorkerRealm` never has: `restart()` replaces `#process` and moves `lifecycle` off its terminal state, but the OLD process's own exit is reported asynchronously and can arrive after that replacement — a `#spawnEpoch` counter captured by each spawn's own `onExit`/`onDisconnect` closures is what makes that stale, late-arriving event a no-op instead of tearing down the NEW process mid-handshake.

### Reclamation proved by observed events, not API return values

The coordinator's own instruction: "prove child exit releases the process (pid no longer alive, IPC closed) and that Worker termination releases its handle, rather than inferring from API return values." `ChildProcessRealm.whenReclaimed()` resolves on `Subprocess.exited`, an OS-level signal; `child-process-realm.test.ts` combines it with `process.kill(pid, 0)` (throws `ESRCH` once the OS has reclaimed the pid, confirmed empirically against Bun 1.4.2) and a post-reclamation `postRawMessageForTesting` call (throws once the IPC channel is closed) to observe both halves directly. The existing Worker-side tests proved reclamation only by spying on `Worker.prototype.terminate`'s call count — evidence that `.terminate()` was CALLED, not that the underlying thread actually went away. Bun's `Worker` fires a real `close` `CloseEvent` on termination (confirmed empirically); `WorkerRealm` gained a symmetric `whenReclaimed()` resolving on that event, and `worker-realm.test.ts` gained tests observing it directly, alongside (not replacing) the existing call-count assertions.

### One shared conformance suite, three realm kinds

`realm-conformance.test-support.ts` extracts the protocol-level assertions `worker-realm.test.ts` and `fake-realm.test.ts` had each written separately (envelope fencing, crash/terminate settling pending turns, bounded restart, a late result after termination being a no-op) into one suite, run once each against `FakeRealm`, `WorkerRealm`, and `ChildProcessRealm` from `realm-conformance.test.ts`. `FakeRealm`'s own port is deliberately synchronous and test-only (`sendReady`/`acceptResult`, no real handshake or message loop) and is therefore excluded from the `RevisionRealm` interface itself; a thin per-kind wrapper normalizes each adapter to one `ConformanceRealm` shape the suite is written against. A "realm reports a failed turn" scenario is deliberately out of the shared suite — `FakeRealm` has no analogous concept distinct from a host-side refusal — and stays covered individually in each real adapter's own test file.

Delivering an incoming result during a conformance test uses a new `receiveRealmMessageForTesting` seam on both real adapters (feeding a message directly into the realm's own inbound handling, the opposite direction of the existing `postRawMessageForTesting`), rather than round-tripping through a fixture's own echo behavior — this is what lets the suite assert an arbitrary literal result value and a deliberately mismatched envelope identically across all three, without depending on what any one fixture script happens to compute.

### Engine integration reuses the R2E path unchanged

`revision-realm-execution-child-process.test.ts` proves the same guarantees `revision-realm-execution.test.ts` (R2E) proves for the Worker transport — the host never importing the workflow implementation module, and a workflow running to completion through `engine.start()`/`engine.signal()` — with `transport: 'child-process'` selected per revision. No change to `construction.ts`, `RevisionRealmExecutionStrategy`, or the `workflowExecutionMode: 'realm'` option surface was needed: transport selection lives entirely in `RevisionRealmConfig`, which the engine integration already threaded through opaquely.

## Alternatives considered

**A shared abstract base class instead of an interface.** `FakeRealm` and `WorkerRealm` already established the pattern of independent concrete classes each composing `RealmLifecycle` and the `realm-protocol` validation functions directly, rather than sharing an inheritance hierarchy — see 0003's and 0004's own module docs. `ChildProcessRealm` follows that precedent rather than introducing a new abstraction layer only to avoid a modest amount of duplicated envelope-fencing logic across two adapters; a shared `RevisionRealm` interface (naming the shape, not the implementation) is enough to let the pool/registry/strategy layer be transport-agnostic.

**A cooperative shutdown message before `.kill()`.** Sending the child a "please exit gracefully" IPC message first would let it release resources itself before termination. Rejected: `WorkerRealm.terminate()`/`.crash()` are already non-cooperative (ADR 0004's own COR-113 deferral), and giving one transport a cooperative shutdown path the other lacks would make the two adapters' terminal behavior observably different, defeating the conformance suite's purpose.

## Remaining COR-246 (and COR-117/COR-249) project criteria

This slice proves: the child-process adapter passes the same protocol conformance suite the Worker adapter and the fake realm do; a child-process realm's crash isolates its own pending turns identically to a Worker realm's; child-process reclamation is observed via `Subprocess.exited`/`process.kill(pid, 0)`/a closed IPC channel, and Worker reclamation via Bun's own `close` event, rather than inferred from either termination API's return value; and the child-process transport is selectable per `(workflowType, revision)` through the same `RevisionRealmRegistry`/engine path R2E wired, with the Worker default unchanged.

It does not build, and explicitly defers:

- COR-243's realm diagnostics, Console views, and `bun --watch`/`bun --hot` guidance — unaffected by which transport backs a realm.
- A production child-process bootstrap module / bundler pipeline that imports real workflow code per revision. This slice's fixture bootstraps stand in for that, exactly as the Worker transport's own fixtures do.
- Cooperative in-flight completion during `Draining` for either transport (COR-113, already deferred by ADR 0004).
- Windows-specific `cmd`/argument-escaping behavior for the child-process transport — this workspace's own test and CI environment is POSIX-only, and `Bun.spawn`'s `windowsHide`/`windowsVerbatimArguments` options are not exercised here.

## Verification

From `packages/weft`:

```bash
bun test src/core/realm
bun test src/core/engine/revision-realm-execution.test.ts
bun test src/core/engine/revision-realm-execution-child-process.test.ts
```

The first line includes `child-process-realm.test.ts`, `realm-conformance.test.ts`, and the retyped `revision-realm-pool.test.ts`/`revision-realm-registry.test.ts`/`worker-realm.test.ts`. From the repository root, `bunx turbo run typecheck lint test --filter=@lostgradient/weft` covers the whole package, and `bun run validate` is the repository-level gate for a full delivery.
