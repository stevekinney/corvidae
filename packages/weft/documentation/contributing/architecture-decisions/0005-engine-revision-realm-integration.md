# Engine integration of revision realms

Status: accepted. This is architecture decision 0005, building on 0003 and 0004.

## Context

ADR 0004 (COR-249) built a real, revision-scoped `WorkerRealm`/`RevisionRealmPool`/`RevisionRealmRegistry` and explicitly deferred wiring a live `Engine` to any of it (its own "Consequences" section, verbatim): "a new `workflowExecutionMode` value (or equivalent option), construction wiring that creates a `RevisionRealmRegistry` and installs it on `EngineInternals`, a `catalog:revision-draining`/`catalog:revision-activated` listener calling `markInactive`/`markActive`, and a strategy (implementing `ExecutionStrategy`) that drives `RevisionRealmRegistry.acquireForExecution`/`dispatchTurn`/`releaseAfterExecution` from `startWorkflow`/`resumeWorkflow`/`cancelWorkflow`." This slice builds exactly that.

## Decision

Add `workflowExecutionMode: 'realm'`, a sibling to `'inline'` and `'worker'`, opt-in and mutually exclusive with `workerExecution`. It requires a new `revisionRealmExecution: { resolveRevisionRealmConfig }` option, and routes every workflow turn through a new `RevisionRealmExecutionStrategy` (`src/core/realm/revision-realm-execution-strategy.ts`) instead of the shared-Worker-pool `WorkerExecutionStrategy`.

### Why `registerSource()`, not a new registration API

The realm-mode registration surface deliberately reuses `engine.registerSource()`/`engine.workflows.activate()` unchanged — the same `WorkflowSourceDescriptor` (`name`, `location`, `exportName`, `revision`) and the same multi-revision catalog, activation, and compatibility machinery `'inline'` mode's dynamic sources already use. Building a second, parallel "declare a workflow's operational metadata without a handler" API was considered and rejected: `RegistrationEntry` (retention, concurrency options, tags, version, contract) is threaded through the entire lifecycle pipeline (`resolveExecutableRegistration`, checkpoint launch, recovery relaunch, revision-pin caching), and a parallel handler-less entry point would either duplicate all of that machinery or require host-side per-revision metadata this project's scope does not need to invent.

The host-side definition `registerSource()`'s loader resolves for a realm-routed `(name, revision)` is real — it goes through the exact same load → validate → durably install pipeline as `'inline'` mode — but it is a **metadata-only placeholder**. `RevisionRealmExecutionStrategy` never reads `RegistrationEntry.handler`; only routing (`workflowType`, the resolved `revision`, retention/concurrency/tags/contract bookkeeping) comes from it. The actual workflow implementation lives in a separate module the realm's own worker bootstrap imports directly — never the host. This is the same "holds a reference, never executes it" posture `ExecutionStrategy`'s own doc already describes for `'worker'` mode, made airtight: where `'worker'` mode's host-registered handler IS the real implementation (merely uncalled), realm mode's host-registered handler is a stub that throws if it is ever accidentally invoked, because the module containing it is never the one the realm imports.

`registerSource()` itself had an inline-only guard (`internals.inlineStrategy === null` refuses it) written for `'worker'` mode, where the reasoning holds fully: a generic Worker has no channel to receive a loaded module or manifest, so registering a dynamic source there would resolve a definition the Worker could never execute. That reasoning does not apply to realm mode — nothing about a resolved placeholder definition is ever "shipped" anywhere — so the guard now reads `internals.inlineStrategy === null && internals.revisionRealmRegistry === undefined`, changing nothing for `'worker'` mode (`revisionRealmRegistry` stays `undefined` there) while allowing it for `'realm'`.

### Why the realm bootstrap URL is explicit, not derived from `location`

`WorkflowSourceDescriptor.location` is documented as a host loader specifier "never parsed, concatenated, or used to construct an import specifier by this package." Weft cannot honestly turn it into a Worker script URL. `revisionRealmExecution.resolveRevisionRealmConfig(workflowType, revision)` instead asks the caller for the full `RevisionRealmConfig` — including `workerUrl` — per `(name, revision)`, mirroring `workerExecution.workerUrl`'s own explicit, caller-supplied shape and ADR 0004's own assumption ("a production bootstrap script ... derives its identity from its own build (one `workerUrl` per revision)"). This project does not build a production revision-bootstrap/bundler pipeline that turns `location` into a real per-revision Worker script — ADR 0004 explicitly deferred that, and it remains deferred.

### Revision resolution: fresh starts vs. recovery

A fresh `engine.start()` already resolves the target revision through the existing dynamic-source machinery (the sole-candidate fast path, or the durable active-pointer read for multiple candidates) before ever calling `strategy.startWorkflow()`, and passes it as `parameters.revision`. `RevisionRealmExecutionStrategy` uses it directly.

A recovery re-launch (`relaunchWorkerWorkflowAfterResume`, engine restart resuming a persisted `running` workflow) calls `strategy.startWorkflow()` again with the persisted checkpoint bytes, but does not pass `revision` — mirroring `'worker'` mode's own call site there. `RevisionRealmExecutionStrategy` falls back to a new `getWorkflowRevisionPin` accessor over the engine's own `internals.workflowTypeByWorkflowId` cache (WFT-19), which every launch path — fresh start, fork, and recovery relaunch — already populates with the exact resolved revision before calling the strategy. This is the durable revision pin: a run recovered after restart keeps executing in its own revision's realm even when a newer revision has since become active, without any change to `ExecutionStrategy`'s public interface or to `resumeWorkflow()`'s parameters.

### Cancellation is non-cooperative

A `WorkerRealm` (ADR 0004, COR-113's own deferral) rejects rather than cooperatively completes a pending turn on drain/terminate. `RevisionRealmExecutionStrategy.cancelWorkflow()` matches that: it immediately releases the realm (drain + terminate), which rejects any in-flight turn, and recognizes that specific rejection as the expected consequence of its own cancellation rather than a workflow failure — the same posture hardened `'worker'` mode's `discardOnCancel: true` already takes. Cooperative in-flight completion during cancellation remains COR-113's scope, not this slice's.

### Activation wiring

`Engine`'s constructor installs two listeners, only when `workflowExecutionMode: 'realm'`: `catalog:revision-draining` calls `RevisionRealmRegistry.markInactive(name, revision)`, and `catalog:revision-activated` calls `markActive(name, revision)`. Both events are dispatched only by `activateCatalogRevisionCandidate()` — the guarded, real activation primitive `engine.workflows.activate()` calls — never synthetically, so a revision realm only ever reacts to a durably applied activation.

### Disposal

`RevisionRealmExecutionStrategy` reuses `WorkerExecutionDisposal` (COR-113) unchanged — the same memoized, idempotent `[Symbol.dispose]`/`[Symbol.asyncDispose]` pair `WorkerExecutionStrategy` uses — wired to `RevisionRealmRegistry.dispose()`, which discards every realm across every pool regardless of state. `Engine`'s own disposal path already calls `internals.strategy[Symbol.dispose]()` unconditionally, so no change to `disposal.ts` was needed.

## Alternatives considered

A handler-less registration API (accepting `(descriptor, config)` with no `WorkflowSourceHandle.load`) was considered for a cleaner "the host truly never touches a loadable reference" story, and rejected: it would require either duplicating `RegistrationEntry`'s retention/concurrency/tags/contract fields as a second, host-supplied configuration surface, or bypassing `resolveExecutableRegistration()` for realm-routed types — both a materially larger, separately-scoped API design decision than "engine integration of revision realms" as chartered. The metadata-only placeholder achieves the same observable guarantee (the host's own module graph never contains the real implementation) by construction, without new registration API surface.

Deriving the realm's Worker URL from `WorkflowSourceDescriptor.location` was rejected for the reason documented above and in `EngineOptions.revisionRealmExecution`'s own doc comment.

## Consequences

- The default `workflowExecutionMode` (omitted, `'inline'`) and `'worker'` paths are unchanged: `normalizeWorkerExecutionConfiguration()` now throws immediately if ever called with `'realm'` (a defensive guard — `createExecutionStrategyBundle` never reaches it for that mode), and `resolveWorkerExecutionForMode()`/`resolveRevisionRealmExecutionForMode()` reject `workerExecution`/`revisionRealmExecution` supplied under the wrong mode symmetrically.
- `registerSource()` now also accepts `workflowExecutionMode: 'realm'`; `'worker'` mode is still rejected.
- `EngineInternals.revisionRealmRegistry` (ADR 0004's own placeholder seam) is now set for a realm-mode engine, closing `reference-counts.ts`'s `activeExecutionRealms` field to a real, live signal end to end.
- COR-246 (Child-process Adapter) and COR-243 (Operational Integration: diagnostics, Console, `bun --watch`/`--hot` guidance) remain fully deferred — nothing in this slice touches them.
- A production revision-bootstrap/bundler pipeline that turns `WorkflowSourceDescriptor.location` into a real, per-revision Worker script remains unbuilt, exactly as ADR 0004 left it. `revisionRealmExecution.resolveRevisionRealmConfig` is the seam such a pipeline would eventually populate.

## Verification

From `packages/weft`:

```bash
bun test src/core/realm
bun test src/core/engine/revision-realm-execution.test.ts
bun test src/core/engine/__tests__/construction.test.ts
bun test src/core/engine/source-registration.test.ts
bun test src/core/engine
bun test src/core/worker-execution-strategy.test.ts
bun test src/core/engine.test.ts
bun test src/core/engine-smol-workers.test.ts
```

From the repository root, `bunx turbo run typecheck lint test --filter=@lostgradient/weft` covers the whole package, and `bun run validate` is the repository-level gate for a full delivery.

## Remaining COR-117/COR-249 project criteria this slice proves at engine level

Using a real `Engine` configured for `workflowExecutionMode: 'realm'`, real Bun `Worker`s, and real `registerSource()`/`workflows.activate()` catalog machinery (`src/core/engine/revision-realm-execution.test.ts`):

- The host process never imports the workflow implementation module — proved dynamically (a sentinel module-scope side effect observed only inside the realm's own isolated global object), alongside the existing static `Bun.build()` proof at the primitive level.
- Two revisions of one workflow execute concurrently in distinct realms, both genuinely mid-turn at once (an explicit per-realm signal-wait barrier, not a timing margin).
- Activation via the real `catalog:revision-activated` event sends new starts to the new revision while a run started before activation completes in the old revision's realm.
- A drained realm (no work pinned to it after its one execution finishes) terminates its real underlying Worker exactly once and is fully reclaimed from the registry; a further execution attempt against the same now-inactive revision is refused before ever reaching a realm.
- Engine disposal terminates every realm exactly once, even under concurrent `[Symbol.asyncDispose]()` calls (COR-113's memoized disposal).
- Engine restart recovery resumes a pinned run in a freshly warmed realm for its own revision, even after a different revision has since become active.

Still deferred, unchanged from ADR 0004:

- A child-process adapter and a Worker/child-process conformance suite (COR-246).
- Realm diagnostics, a Console view, and `bun --watch`/`bun --hot` production guidance (COR-243).
- A production revision-bootstrap/bundler pipeline (see "Consequences" above).
