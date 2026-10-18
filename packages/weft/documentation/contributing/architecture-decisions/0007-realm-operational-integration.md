# Realm operational integration

Status: accepted. This is architecture decision 0007, building on 0003, 0004, 0005, and 0006.

## Context

ADR 0006 explicitly deferred "COR-243's realm diagnostics, Console views, and `bun --watch`/`bun --hot` guidance — unaffected by which transport backs a realm." COR-243's own issue text: "Add realm diagnostics, Console views, watch-mode documentation, and controlled rolling-restart guidance." This ADR is not retroactively editing 0003–0006's own "remains deferred"/"can implement once it exists" language — those are point-in-time decision records, not living status documents, matching this ADR series' own established precedent (0006 did not edit 0003–0005's stale COR-246 deferrals either; it added itself instead).

## Decision

### Realm diagnostics: a bounded operation over data the realm subsystem already tracked

`RevisionRealm` (0006) already exposed everything a diagnostics surface needs on its own public port: `lifecycle.state`, `lifecycle.restartCount`, `activation.realmGeneration`, and `pendingTurnCount`. No new tracking was needed — `RevisionRealmPool.diagnostics()` and `RevisionRealmRegistry.listDiagnostics()` (`src/core/realm/revision-realm-diagnostics.ts`) are pure projections of that existing state into a bounded, wire-safe shape, and `getRevisionRealmDiagnostics(engine)` (`src/core/engine/revision-realm-diagnostics.ts`) is the public core entry point, mirroring `getWorkflowRevisionDiagnostics`'s own shape and reading the same opt-in `EngineInternals.revisionRealmRegistry` `countWorkflowRevisionReferences` already reads for `activeExecutionRealms`.

`weft.realms.diagnostics` (`GET /v1/realms/diagnostics`) is static, not factory-built — like `weft.catalog.diagnostics`, it needs no per-server state beyond the live `engine` every `invoke` already receives. It returns `pools: []` for a host that never opted into `workflowExecutionMode: 'realm'`, matching every other realm diagnostic's "absent means empty/zero" convention, rather than faulting.

A pool that has been `ensurePool`d but currently tracks no realms (an active revision with nothing warmed yet, or a revision whose only realm has drained while the revision itself is still the catalog's active pointer — see `RevisionRealmPool.isDrained`'s own doc: only `markInactive` plus zero active realms reclaims a pool) still appears in the output with an empty `realms` array. Silently omitting it would make an idle-but-active revision indistinguishable from one this engine has never heard of.

### Console: one route, existing conventions, no new abstraction

The Console's System route (`applications/interborough/src/routes/system/`) already has one tab per bounded diagnostics surface (Registry, Health, Discovery, ...), each following the same shape: a pure row-projection module (`*-view.ts`) plus a `createQuery`-backed `.svelte` component using Cinder's `Table`/`Badge`/`EmptyState`. The Realms tab (`realms-tab.svelte` + `realms-view.ts`) follows that convention exactly rather than introducing a new pattern, and reuses Cinder components throughout (no bespoke table, badge, or empty-state markup).

### `bun --watch`: coarse, but consistent, because it reloads uniformly

Confirmed empirically against Bun 1.4.2 before writing `bun-watch-restart.test.ts`: `bun --watch <entrypoint>` reloads the target module in the **same OS process** (no child process spawned, so no orphan-process cleanup concern) but with a **fresh module scope** on every reload — every top-level binding, including an `Engine` instance and its `Bun.serve()` listener, is torn down and recreated together. A durable checkpoint (`ctx.waitForSignal`, a timer, a remote activity result) lives in storage, not in the reloaded module's memory, so the freshly constructed `Engine`'s own `recoverAll()` resumes it exactly as an ordinary process restart would. That is documented as a supported development and coarse-production strategy in `documentation/guides/workflow-revisions.md`, with the stated cost: no isolation between generations and no rolling/staged rollout, unlike a real process-manager-driven restart.

`bun --hot` is explicitly rejected for this host in production, documented with the concrete reason: `--hot`'s design goal is preserving as much running state as possible across a reload, including an **already-executing generator's closure**, while the module's other top-level bindings (the `Engine` instance, timers, the HTTP listener) still get recreated fresh. That is a torn mix of one generation's generator against another generation's singletons that nothing in this project's execution model is built to detect or reconcile — the failure mode is silent rather than a clean restart. This hazard is orthogonal to the engine's own workflow **revision** isolation (0003–0006): it happens at the Bun module-reload layer, beneath any revision the engine itself tracks.

### Resident parking (worker mode): documented, not just tested

The 2026-09-25 audit refutation on this project found `workflowExecutionMode: 'worker'`'s resident-parking mechanism (`WorkerPool.acquireSpecificWorker`, `WorkerExecutionStrategy#parkCheckpointIfStillWaiting`) genuinely well-tested but never published anywhere a consumer or operator would read it — only in inline code comments. `documentation/guides/workflow-revisions.md` now has a dedicated section stating plainly: parking is a best-effort resume-locality optimization, not a reservation (a parked `Worker` is returned to the pool's ordinary availability and can be taken by another workflow meanwhile); resumption always waits for the exact parked `Worker` rather than silently substituting a different one; and losing the in-memory parked `Worker` for any reason never loses the workflow's durable checkpoint, which lives in storage and recovers the same way any other durably suspended workflow does.

## Remaining COR-117 project criteria

This slice is COR-117's project's final slice. Re-verified directly against the code as it stands after this slice (not against the 2026-09-25 audit, which predates the R1–R4 merges this slice builds on): all 13 of COR-117's acceptance criteria now have direct evidence — implementation `file:line` plus the exact test proving it — recorded in this package's delivery record. Criteria 1–10 were already proven by 0003–0006's own work (re-confirmed here, not re-built): the module-boundary bundle test (criterion 1), `WorkerRealmReadiness`'s artifact-digest rejection tests (criterion 2), the two-revisions-concurrent engine test (criteria 3–4), `RevisionRealmPool`'s pinned-run-survives-`markInactive` test (criterion 5), the drained-realm-rejects-a-late-result tests at the fake-realm, conformance-suite, and registry levels (criterion 6), the crash-isolates-siblings tests (criterion 7), the memoized-idempotent-disposal tests for both `WorkerExecutionStrategy` and `RevisionRealmExecutionStrategy` (criterion 8, COR-113's own scope — already delivered, not deferred), the wrong-revision/generation/token/turnId rejection tests (criterion 9), and the one shared conformance suite run against `FakeRealm`, `WorkerRealm`, and `ChildProcessRealm` (criterion 10). Criteria 11–13 are this slice's own delivery: resident parking now documented as well as tested (criterion 11), the `bun --watch` restart-recovery integration test (criterion 12), and the `bun --hot` production rejection with its reason (criterion 13).

## Alternatives considered

**A new `weft.realms.<name>.<revision>.diagnostics` operation, one call per `(name, revision)`, mirroring `weft.catalog.diagnostics`'s per-key shape.** Rejected: the Console's own use case is a fleet-wide table (every realm pool at once), which a per-key operation would need N calls to populate with no way to discover the key set up front. A single host-wide listing, matching `weft.workers.list`'s own shape, is one call and one query key.

**Building a real production per-revision bootstrap/bundler pipeline as part of this slice.** Out of scope: ADR 0005 already deferred this ("a real production pipeline that turns `location` into a bootstrap script for you"), and COR-243's own text is diagnostics/Console/watch-mode guidance, not deployment tooling.

## Verification

From `packages/weft`:

```bash
bun test src/core/realm/revision-realm-pool.test.ts
bun test src/core/realm/revision-realm-registry.test.ts
bun test src/core/engine/revision-realm-execution.test.ts
bun test src/server/operations/get-realm-diagnostics.test.ts
bun test src/server/bun-watch-restart.test.ts
bun scripts/generate-operation-client.ts
bun test scripts/generate-operation-client.test.ts
```

For the console, from `applications/interborough`:

```bash
bun --config=./bunfig.ui.toml test --conditions browser --conditions svelte src/routes/system/realms-view.test.ts src/routes/system/realms-tab.test.ts src/routes/system/index.test.ts
```

From the repository root, `bunx turbo run typecheck lint test --filter=@lostgradient/weft` covers the engine and the UI, and `bun run validate` is the repository-level gate for a full delivery.
