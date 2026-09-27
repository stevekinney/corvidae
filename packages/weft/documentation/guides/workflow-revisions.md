# Workflow revisions and lazy loading

When you deploy a new workflow, existing runs may still need the definition they started with. A workflow name tells you which business process to start; a revision tells Weft which registered definition a particular run owns. Keep those identities separate, and you can load workflows on demand without silently moving an older run to the current definition.

This guide covers the versioned catalog, dynamic sources, compatibility checks, and durable revision binding. The separate [agent workflow versioning guide](../../../../documentation/workflow-versioning.md) describes Operative's deployment stamp. That stamp reports code drift; it does not supply the old code needed by an exact Weft revision.

## Three identities

| Identity | Meaning | When it changes |
| --- | --- | --- |
| `workflowVersion` | The author's declared recovery compatibility boundary | When the author changes the workflow version |
| `contractHash` | Hash of the public payload contract | When schemas, signals, queries, updates, activities, or the finalizer contract change |
| `revision` | Identity of a particular catalog manifest | By default, when the normalized contract changes, including its name, version, description, or tags |

The default revision is derived from the normalized contract. It is not a hash of the function body or the executable bundle. Changing only a handler's implementation does not automatically produce a new revision. Keep revision metadata and the code your host loads consistent; a matching revision is not proof that two bundles contain identical bytes. Worker artifacts have their own [artifact identity](../reference/api-workers.md#canonical-worker-manifest).

You can build a manifest through the public API. This example has no payload schemas, so it describes an unconstrained payload contract:

```typescript
import { buildWorkflowContract, buildWorkflowRevisionManifest } from '@lostgradient/weft';

const contract = buildWorkflowContract({ name: 'greeting', version: '1.0.0' });
const manifest = await buildWorkflowRevisionManifest(contract);

console.log(manifest.revision, manifest.contractHash);
```

For a real workflow, include its declared schemas, message contracts, scoped activities, and finalizer. A manually assembled contract that omits an activity will disagree with the manifest derived from the registered definition. Use the server's `/api/v1/registry` snapshot for client generation and [`buildWorkerManifestFromRegistry(engine, options)`](../reference/api-workers.md#buildworkermanifestfromregistryengine-options) for worker manifests from existing registrations.

## Loading a workflow on demand

A **workflow source** pairs serializable metadata with a host-owned loader function. The metadata names a module and export; the function actually loads it. Weft never turns an arbitrary `location` string into an import on your behalf.

For example, place this definition in your consuming workspace's `greeting.ts`:

```typescript
import { workflow } from '@lostgradient/weft';

export const greeting = workflow({ name: 'greeting', version: '1.0.0' }).execute(async function* (
  _context,
  name: string,
) {
  return `Hello, ${name}!`;
});
```

The host registers the source without importing that module. Here, the manifest matches the definition's deliberately small contract; a production host should obtain the matching metadata from its artifact preparation process.

```typescript
import {
  BunSQLiteStorage,
  Engine,
  buildWorkflowContract,
  buildWorkflowRevisionManifest,
  workflowSource,
} from '@lostgradient/weft';

const manifest = await buildWorkflowRevisionManifest(
  buildWorkflowContract({ name: 'greeting', version: '1.0.0' }),
);

const source = workflowSource(
  {
    name: 'greeting',
    location: './greeting.ts',
    exportName: 'greeting',
    revision: manifest.revision,
    workflowVersion: manifest.workflowVersion,
    contractHash: manifest.contractHash,
  },
  () => import('./greeting.ts'),
);

await using storage = new BunSQLiteStorage('./greetings.db');
await using engine = new Engine({ storage });
engine.registerSource(source);
await engine.recoverAll();

const handle = await engine.start('greeting', 'Steve');
console.log(await handle.result());
```

Register every source needed by persisted runs before calling `recoverAll()`. The constructor-based example makes that ordering explicit. Eager workflows and lazy sources can coexist, but do not register the same workflow name as both an eager definition and a dynamic source.

Use a literal `import('./greeting.ts')` so [TypeScript](https://www.typescriptlang.org/docs/handbook/modules/reference.html) preserves the named export's types. An arbitrary path variable does not establish a typed module contract. Runtime validation still checks the selected export, workflow name, derived revision, and optional version and contract-hash expectations before installation.

### Preloading and cancellation

Preload a source when you want deployment readiness to include loading and validation before the first request:

```typescript partial
await engine.workflows.preload('greeting', manifest.revision, {
  signal: AbortSignal.timeout(5_000),
});
```

`engine.resolveWorkflowSource(name, revision, options)` has the same contract. Concurrent callers for the same `(name, revision)` share one in-flight load. Successful resolution is cached; a failed attempt is removed so a later request can try again. A failure for one revision does not poison another revision's loader.

Aborting a caller stops that caller's wait. It does not cancel another caller's wait or forcibly interrupt an import already running. Native module evaluation and its side effects remain the host's responsibility. Disposal fences late source installation; it is not a sandbox for module code.

## Installing and activating

Installation records an immutable manifest. Activation changes the catalog's advertised active revision. Neither operation downloads code. `engine.workflows.install(manifest)` requires an in-process definition for the workflow name; lazy sources load and install through `preload()` instead.

| Operation | Result |
| --- | --- |
| `install(manifest)` | Installed manifest and installation timestamp; an identical reinstall is idempotent |
| `getRevision(name, revision)` | One installed record, or `null` |
| `listRevisions(name)` | Installed records sorted by revision |
| `getActive(name)` | Active revision, generation, and activation timestamp, or `null` |
| `activate(name, revision, options)` | An explicit applied or refused result |

An active pointer has a **generation**: a counter used to reject an activation based on an outdated observation. Read it before changing the pointer, supply it as `expectedGeneration`, and inspect the result:

```typescript partial
const current = await engine.workflows.getActive('greeting');
const result = await engine.workflows.activate('greeting', manifest.revision, {
  ...(current === null ? {} : { expectedGeneration: current.generation }),
});

if (!result.applied) {
  throw new Error(`Workflow activation refused: ${result.reason}`);
}
```

Once a pointer exists, omitting `expectedGeneration` returns `expected-generation-required`. An outdated generation returns `stale-generation`; a competing conditional write can return `conflict`. These are returned refusals, not thrown errors. An awaited call is not evidence that activation succeeded.

`getActive()` reports the process's catalog view, which can lag another engine's writes. The durable conditional write still guards activation. On contention, refresh the host's catalog observation and reassess the candidate instead of repeatedly submitting the same generation.

By default, compatibility requires the same name, supported manifest version, equal payload contract hash, equal workflow version, and exact revision. `policy: { requireExactRevision: false }` relaxes only the last check. It does not permit payload-contract drift, version ranges, or automatic schema migration. Review an `incompatible` result's `verdict.reasons` before changing policy.

## What runs after activation

Lazy execution resolves a registered source for the selected revision. New runs persist the resolved revision during admission; recovery resolves that persisted revision rather than substituting whichever source is active now. Keep old source descriptors and loader capabilities available for as long as their runs can recover.

Eager registration has a narrower contract: the process executes the definition it registered and stamps that definition's revision. Advertising another manifest in the catalog does not replace the eager function. Use revision-specific sources when one host must retain multiple executable revisions of a workflow name.

If a persisted revision cannot be resolved, `recoverAll()` can mark affected runs failed with a revision-unavailable error instead of falling back to unrelated code. Other recoverable revisions can continue. Restore and preload the missing source before admitting more work, then inspect each failed run's committed effects. A failed run is not resumed by another recovery scan: `engine.resume(id)` accepts only running or suspended runs. Starting a replacement through `engine.start()` creates a new execution, so choose a new identifier and reconcile external effects before repeating business operations.

### Scheduled runs

Schedules choose between `revisionPolicy: 'active-at-fire'` and `revisionPolicy: 'pinned'`. The default is `active-at-fire`: each occurrence selects at firing time. A pinned schedule captures its revision when you create the schedule and retains that binding for future occurrences.

The schedule call remains the normal API; the revision policy belongs in its options:

```typescript partial
await engine.schedule('greeting', 'Steve', '0 9 * * *', {
  revisionPolicy: 'pinned',
});
```

Use a pinned schedule when a recurring business process must remain on the reviewed definition. Use active-at-fire when changing the active source should affect future occurrences. Existing runs keep their own persisted revision in either case. A pinned schedule also keeps that revision in use even between occurrences.

### Retention and removal

Retain definitions while nonterminal runs or pinned schedules still reference them. Revision removal checks durable references; a tombstone prevents another process from resurrecting the removed revision through a stale load. Do not delete catalog keys or artifact files as a substitute for the removal API.

Use `getWorkflowRevisionDiagnostics(engine, name, revision)` to inspect references and `removeWorkflowRevision(engine, name, revision)` to request removal. Both are package-root exports. Removal returns `removed: false` with `active`, `referenced`, `not-found`, or `conflict` when it cannot remove the entry; inspect that result before retiring the artifact. Reference checks include durable scans, so account for store size before putting removal on a frequent timer.

Fork, recovery, and terminal cleanup also preserve or check revision identity. Forking a persisted run is not an implicit upgrade to the active revision. Decide how old code remains available before you retire an artifact.

## Revision realms

Both `'inline'` and `'worker'` execution modes load a workflow's real implementation module into the host process — `'worker'` mode never _invokes_ the handler it holds, but it still imports it to register it. `workflowExecutionMode: 'realm'` (COR-249, ADR 0005) goes further: the host never imports the implementation module at all. Each immutable `(name, revision)` gets its own pool of realms, and only a realm's own bootstrap script imports the real code.

Opting in requires two things: `workflowExecutionMode: 'realm'` and `revisionRealmExecution.resolveRevisionRealmConfig`, a function mapping `(workflowType, revision)` to a `RevisionRealmConfig` — most importantly the realm's own `workerUrl`. Weft cannot honestly turn a `registerSource()` descriptor's `location` into a Worker script URL (see that field's own doc), so you supply the bootstrap URL for each revision explicitly, exactly the way `workerExecution.workerUrl` already works for `'worker'` mode.

`RevisionRealmConfig.transport` selects which real process backs a revision's realms: `'worker'` (a real Bun `Worker`, the default when `transport` is omitted — unchanged from before this option existed) or `'child-process'` (a real `Bun.spawn` IPC child process, COR-246). A child process is a stronger crash/resource boundary than a Worker's shared-process heap — a realm that segfaults, leaks native memory, or hangs the event loop cannot corrupt the host's own process the way a Worker thread sharing the host's address space theoretically could — at the cost of a real OS process per realm rather than a thread, so it suits untrusted or failure-prone workflow code. The transport is selected per `(workflowType, revision)`, so `resolveRevisionRealmConfig` can mix both in one engine. `workerUrl` doubles as the child-process bootstrap script path under this transport; both speak the identical realm protocol, so only the transport and the resource-boundary knobs (`env`) differ, never the protocol or the engine-visible behavior.

You still register each revision through the ordinary `registerSource()`/`workflows.activate()` catalog — the same multi-revision tracking, compatibility checks, and activation events every dynamic source uses. The definition you register is a **metadata-only placeholder**: its `handler` is never invoked (`RevisionRealmExecutionStrategy` routes every turn to the realm instead), so it only needs to match the real implementation's declared contract, name, and version. The real generator body lives in a separate module that only the realm's own bootstrap script imports:

```typescript
// checkout-v1.workflow.ts — the REAL implementation.
// Imported only by checkout-v1-worker.ts below, never by the host.
import { workflow } from '@lostgradient/weft';

export const checkout = workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* (
  _ctx,
  cartId: string,
) {
  return `shipped:${cartId}`;
});
```

`checkout-v1-worker.ts` (the `workerUrl` above points at it) is the one piece this guide cannot hand you as a copy-pasteable public import: **a production revision-bootstrap helper is not yet published API.** ADR 0004 deferred building one, and this project's own engine-level tests use a package-internal, test-only reference implementation (`src/core/realm/__fixtures__/revision-realm-generator-worker-entry.ts`) rather than a supported export. Until a public one ships, your bootstrap script owns the wire protocol directly: listen for `realm-configure`, respond with a `ready` handshake, then on each `realm-run` message step the real generator and reply with `realm-result`/`realm-failure`. Read `src/core/realm/__fixtures__/revision-realm-generator-worker-entry.ts` for a complete, tested implementation of that protocol (it reuses this project's own internal generator-stepping helpers) and `src/core/realm/worker-realm-messages.ts` for the exact message shapes (`RealmRunMessage`/`RealmResultMessage`/`RealmFailureMessage`) before writing one.

```typescript
// host.ts — never imports checkout-v1.workflow.ts.
import { Engine, workflow, workflowSource } from '@lostgradient/weft';

const checkoutRevisionV1 = 'sha256:...'; // the same content-derived revision the real implementation resolves to

const engine = new Engine({
  workflowExecutionMode: 'realm',
  revisionRealmExecution: {
    resolveRevisionRealmConfig: (workflowType, revision) => {
      if (workflowType === 'checkout' && revision === checkoutRevisionV1) {
        return {
          workerUrl: new URL('./checkout-v1-worker.ts', import.meta.url),
          expectedWorkflowTypes: ['checkout'],
        };
      }
      return undefined;
    },
  },
});

// A placeholder — never invoked. Its contract must match the real
// implementation's; its body never runs.
const checkoutPlaceholder = workflow({ name: 'checkout', version: '1.0.0' }).execute(
  async function* () {
    throw new Error('checkout: placeholder handler invoked on the host — this should never happen');
  },
);

engine.registerSource(
  workflowSource(
    {
      name: 'checkout',
      location: './checkout-v1.workflow.ts',
      exportName: 'checkout',
      revision: checkoutRevisionV1,
    },
    async () => ({ checkout: checkoutPlaceholder }),
  ),
);
await engine.resolveWorkflowSource('checkout', checkoutRevisionV1);
await engine.workflows.activate('checkout', checkoutRevisionV1);

await engine.start('checkout', 'cart-42');
```

Activation and recovery behave exactly like any other dynamic source: `catalog:revision-activated` routes new starts to the newly active revision while a run already executing keeps its own realm until it finishes; a run recovered after a process restart resumes in its own pinned revision's realm even if a newer revision has since become active, using the same durable revision pin `WorkflowState.revision` already carries.

Two things this mode does **not** provide, matching ADR 0005's own scope: a real production pipeline that turns `location` into a bootstrap script for you (you build and point `workerUrl` at your own per-revision bundle, for either transport), and cooperative in-flight completion on cancellation — a realm-mode workflow's cancellation is non-cooperative, matching hardened `'worker'` mode's own `discardOnCancel` posture.

See [ADR 0003](../contributing/architecture-decisions/0003-revision-realm-lifecycle-and-protocol.md), [ADR 0004](../contributing/architecture-decisions/0004-worker-revision-realm-pool.md), [ADR 0005](../contributing/architecture-decisions/0005-engine-revision-realm-integration.md), [ADR 0006](../contributing/architecture-decisions/0006-child-process-revision-realm.md), and [ADR 0007](../contributing/architecture-decisions/0007-realm-operational-integration.md) for the full lifecycle, protocol, engine-integration, and operational-integration design; [`revision-realm-execution.test.ts`](../../src/core/engine/revision-realm-execution.test.ts) and [`revision-realm-execution-child-process.test.ts`](../../src/core/engine/revision-realm-execution-child-process.test.ts) are the source-verified, runnable versions of the example above.

## Realm diagnostics and the Console (COR-243)

The `weft.realms.diagnostics` operation (`GET /v1/realms/diagnostics`) reports every `(name, revision)` realm pool the live engine currently owns: whether the catalog still considers it the active pointer (`revisionActive`), and each realm's lifecycle state (`warming`/`ready`/`active`/`draining`/`terminated`/`crashed`), activation generation, restart count, and in-flight turn count. It requires `system:read`, is classified non-destructive, and returns `pools: []` for an engine that never set `workflowExecutionMode: 'realm'` — never an error.

```typescript
import { HttpClient } from '@lostgradient/weft';

const client = new HttpClient({ baseUrl: 'https://weft.example.com' });
const diagnostics = await client.operations['weft.realms.diagnostics']({});
console.log(diagnostics.pools.length, 'realm pool(s)');
```

The Console's System tab has a matching **Realms** view (`components/weft-ui/src/routes/system/realms-tab.svelte`) rendering the same data as a table, one row per realm — or one row for a pool tracking no realms yet, so an active, idle revision is still visible rather than silently absent.

## `bun --watch` in development and coarse production deployment, and why `bun --hot` is rejected for this host

**`bun --watch <entrypoint>` is a supported strategy for both local development and a coarse production deployment** of the durable engine host (`serve()`'s process): editing a file the entrypoint imports makes Bun fully tear down and re-run the module from the top in the same OS process — no child process, and no manual restart script required. Every top-level binding — the `Engine` instance, its storage handle, and its `Bun.serve()` listener — is recreated together on each reload; nothing from before the reload survives implicitly. A workflow parked on a durable checkpoint (`ctx.waitForSignal`, a timer, a remote activity) is unaffected: the checkpoint lives in durable storage, not in the reloaded module's memory, so the freshly constructed `Engine`'s own `recoverAll()` call resumes it exactly like an ordinary process restart would. [`bun-watch-restart.test.ts`](../../src/server/bun-watch-restart.test.ts) proves this against a real `bun --watch` subprocess: a workflow started before a `bun --watch`-triggered reload completes correctly after it, addressed only through the reloaded process's own fresh HTTP listener.

Calling this strategy "coarse" is deliberate: a reload has no isolation between generations (unlike a real process restart, which gets a fresh heap and file descriptor table from the OS) and no rolling/staged rollout — every in-flight request loses its connection at the moment of reload, and every durable run resumes only once the reload finishes. For workloads that need graceful draining, blue/green rollout, or OS-level resource isolation between deployments, use a real process supervisor (a process manager, container orchestrator, or `systemd`) that starts a fresh `bun run <entrypoint>` process and only routes traffic to it once its own readiness check passes — `bun --watch` is not a substitute for that.

**`bun --hot` is explicitly rejected for this host in production.** `--hot`'s whole premise is preserving as much running state as possible across a reload — including live generator instances and closures already in flight — while `--watch` tears everything down uniformly. For an ordinary script that is a feature. For the durable engine host it is a hazard: a `bun --hot` reload can leave an **old, already-executing workflow generator's closure alive**, still referencing the pre-reload module's bindings, while the module-level `Engine` instance, its timers, and its `Bun.serve()` listener are recreated fresh under the new code — a torn mix of one generation's generator against another generation's singletons. Nothing in this project's execution model is designed to detect or reconcile that mix; the failure mode is silent (no error, no crash — an in-flight run just keeps executing against stale bindings) rather than a clean restart. Restart the host with `bun --watch` or a full process restart instead of `bun --hot` whenever the workflow contract, activity implementations, or engine construction code may have changed. (This is unrelated to `Engine`'s own workflow **revision** isolation described above — `bun --hot`'s hazard is at the Bun module-reload layer, beneath any revision the engine tracks.)

## Resident parking in worker mode

`workflowExecutionMode: 'worker'` (in-process Bun `Worker` threads, the sibling of `'realm'` and `'inline'`) keeps a workflow's `Worker` **parked** rather than immediately returning it to the general pool when that workflow suspends on a durable wait-signal checkpoint. Parking is a pure performance optimization: the parked `Worker`'s own generator and module state stay warm in memory, so resuming that exact workflow later reuses it instead of cold-starting a fresh `Worker` and replaying the workflow's history from scratch inside it.

Parking is best-effort, not a reservation. The parked `Worker` is returned to the pool's ordinary availability (`WorkerPool.release`) — an unrelated workflow's `acquire()` call can and does take it in the meantime if it is otherwise idle. Resuming the parked workflow always waits for that _exact_ `Worker` to come free again (`WorkerPool.acquireSpecificWorker`) rather than silently falling back to a different one, so a busy parked `Worker` can add latency to a resume, but never causes it to resume against the wrong `Worker`'s state.

**Checkpoint eviction is not implied.** There is no separate capacity limit or eviction policy for parked workflows distinct from the pool's own `concurrency` bound, and losing the in-memory parked `Worker` — whether it crashes while parked (handled by the same fault path as any other `Worker` failure) or the process restarts — never loses the workflow's durable checkpoint. That checkpoint lives in storage, not in the parked `Worker`'s memory; `engine.recoverAll()` resumes it the same way it resumes any other durably suspended workflow, just without the warm-`Worker` optimization. Parking changes resume performance, never durability or correctness.

## Client types and runtime validation

Registry snapshot version `2` contains a deterministic array of workflow revision manifests and an `activeRevisions` map. Generated client declarations describe the active payload contracts while retaining revision metadata. Unsupported schema constructs become `unknown`; generated types do not pretend an unsupported schema is narrower than it is.

From the repository root, inspect the source CLI and generate declarations from a saved registry snapshot:

```bash
bun packages/weft/src/cli-main.ts codegen --help
bun packages/weft/src/cli-main.ts codegen --from ./registry.json --out ./weft.generated.d.ts
```

`--server` reads a server instead of a file; it cannot be combined with `--from`. `--out` is required. Include the generated declaration in the consuming application's TypeScript project. Regenerate it after changing the active contract and still validate unknown network inputs at runtime: a declaration file cannot validate a response.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| First start fails during source loading | Export name, workflow name, matching contract metadata, and loader rejection |
| Activation resolves but nothing changes | The returned `applied` discriminator and refusal reason |
| Active catalog revision differs from executed code | Whether this is an eager registration or a revision-specific source |
| Recovery cannot resolve an old run | The persisted revision and availability of its source and artifact |
| A cancelled preload still imports code | Cancellation ends the wait; native import is not forcibly cancelled |
| Handler change has the same derived revision | Revisions derive from declared contracts, not function bodies |

The [source resolver](../../src/core/engine/source-resolution.ts), [catalog namespace](../../src/core/engine/engine-workflows-namespace.ts), [compatibility checks](../../src/core/contract/compatibility.ts), and [schedule policy tests](../../src/core/engine/schedule-revision-policy.test.ts) define these boundaries. For executable regression evidence, run the focused catalog, source, and revision tests before changing the contract.
