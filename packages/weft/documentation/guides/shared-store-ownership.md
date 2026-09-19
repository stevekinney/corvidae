# Sharing a durable store across engines

Two engines can read the same checkpoint and both decide to resume it. Rejecting the second checkpoint write is too late if both engines have already called an external service. Weft's per-workflow ownership mode claims the workflow before running its generator and fences later writes against that claim.

Choose an ownership mode explicitly when more than one process can reach a durable store. Storage durability and execution ownership answer different questions: keeping a checkpoint does not decide who may advance it.

## Choosing a mode

| `ownership` | Execution model | Use it when |
| --- | --- | --- |
| `'none'` | No cross-engine ownership coordination; the default | Exactly one engine uses the store |
| `'lease'` | One store-wide owner; other engines wait for that lease | You need a single active engine with takeover |
| `'workflow-lease'` | One owner per workflow; different engines can advance different workflows | Multiple engines intentionally share a store |

Both lease modes require a storage adapter with `conditionalBatch`: an atomic operation that checks expected bytes and applies writes only if those expectations still hold. The storage backend must make those checks authoritative across the participating processes. An in-memory adapter is useful for tests but does not share state across processes.

For a shared database, each process creates its own connection to the same store and uses the same ownership mode. This minimal local example uses [Bun](https://bun.sh/)'s SQLite adapter; choose storage appropriate to your deployment topology before distributing engines across hosts.

```typescript
import { BunSQLiteStorage, Engine, workflow } from '@corvidae/weft';

const greeting = workflow({ name: 'greeting' }).execute(async function* (_context, name: string) {
  return `Hello, ${name}!`;
});

await using storage = new BunSQLiteStorage('./shared-workflows.db');
await using engine = await Engine.create({
  storage,
  workflows: { greeting },
  ownership: 'workflow-lease',
});

const handle = await engine.start('greeting', 'Steve');
console.log(await handle.result());
```

`Engine.create()` checks the storage capability and persisted ownership mode before recovery or scheduling begins. A missing capability fails construction. A conflicting mode raises `OwnershipModeMismatchError`; it does not silently fall back to uncoordinated execution.

## Claims, renewal, and takeover

A **claim** is the durable ownership record for a workflow. Its fencing identity distinguishes the current owner from a previous process that resumes after a pause or network interruption. Starts, recovery, and later engine-owned advancement confirm ownership before executing work. A stale owner cannot commit a checkpoint under its old claim.

The current owner renews its claims. If it crashes, another engine can acquire an expired claim and resume from durable state. Takeover still depends on a participating engine running recovery or maintenance; expiry does not start a replacement process for you.

| Option | Default | Constraint |
| --- | --- | --- |
| `workflowClaimTtl` | 30 seconds | Positive and at least three times the renewal interval |
| `workflowClaimRenewInterval` | 5 seconds | Positive and strictly below the claim lifetime |
| `leaseTtl` | 30 seconds | Store-wide lease mode only; positive |
| `leaseRenewInterval` | 5 seconds | Store-wide lease mode only; strictly below the lease lifetime |
| `leaseWaitTimeout` | 60 seconds | Positive boot-time wait for the store-wide lease |

Keep the default timing unless measurements of your storage latency and scheduling pauses justify a different configuration. A longer claim lifetime also makes crash takeover slower. Per-workflow ownership cannot be combined with `detectSecondInstance: true`, because that detector assumes one global owner.

### Host-driven maintenance

With `backgroundTasks: 'manual'`, the host owns the maintenance cadence. Per-workflow ownership supports this mode: call and await `engine.runMaintenance()` regularly enough to renew claims before they expire. Concurrent calls are supported, but awaiting each cycle before scheduling the next keeps the host's cadence easier to reason about. A virtual clock in a test must advance along with explicit maintenance calls.

The store-wide `'lease'` mode does not support manual background tasks. Configure the supported posture rather than assuming a manual host tick renews a global lease.

### Side effects

Fencing protects Weft's writes. It cannot retract a payment, email, or database update already accepted by another system. Continue using idempotency keys or external write fencing for activities. The workflow execution token and activity attempt token distinguish replaced runs and attempts; they are not a promise of exactly-once external execution.

## Deployment and shutdown

A rolling deployment within the same ownership mode can overlap processes. Await asynchronous engine disposal during a clean shutdown so release finishes before you close the storage connection. The `await using` declarations above dispose the engine before its storage because declarations are disposed in reverse order.

Synchronous disposal initiates cleanup but cannot wait for a durable release. Use it only when that weaker boundary is acceptable; crash recovery then depends on claim expiry and takeover.

Changing modes is a coordinated operation. Stop every writer, preserve a recoverable store snapshot, verify that no old engine can return, and deliberately reconcile the ownership-mode marker before starting the new topology. A `'lease'` marker and a `'workflow-lease'` marker are mutually exclusive. Do not remove a marker while engines are live.

An engine configured with `'none'` does not enforce the marker. The marker therefore cannot protect you from an older or misconfigured uncoordinated writer. Mixed deployments that ignore the selected fencing protocol are unsupported. A rollback must restore a consistent mode and topology, along with code capable of reading the stored state; changing a package version alone is insufficient.

## Troubleshooting ownership

| Symptom | Interpretation and next check |
| --- | --- |
| Construction rejects `conditionalBatch` | The selected adapter cannot provide the configured ownership boundary |
| `OwnershipModeMismatchError` | Another fenced topology established the store's mode; inspect deployment configuration before changing data |
| `WorkflowClaimUnavailableError` | This engine could not obtain the claim; another owner may legitimately be progressing the workflow |
| Repeated claim loss | Check event-loop pauses, maintenance cadence, and storage availability |
| Slow takeover | Check claim expiry and whether a replacement engine is actually running recovery or maintenance |
| A stale activity still affects an external system | That system needs its own idempotency or fencing check |

`getLeaseHealth()` is a process-local diagnostic for the store-wide lease. It is not a per-workflow ownership inventory or a fresh cross-process storage read. The per-workflow [claim recorder](../../src/core/engine/workflow-claim-metrics.ts) tracks bounded acquisition outcomes, active claims, and renewal failures internally; do not assume every internal counter is exposed by a server metrics endpoint.

The [ownership options](../../src/core/engine/ownership-options.ts), [bootstrap](../../src/core/engine/ownership-bootstrap.ts), and [multi-engine regression tests](../../src/core/engine/workflow-lease-ownership.test.ts) are the source contracts. To verify the boundary after an ownership change, run:

```bash
bun test packages/weft/src/core/engine/workflow-lease-ownership.test.ts packages/weft/src/core/engine/ownership-mode-marker.test.ts packages/weft/src/core/engine/ownership-options.test.ts
```
