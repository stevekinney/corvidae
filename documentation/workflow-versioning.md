# Workflow versioning for in-flight durable runs

`@corvidae/operative` uses a caller-supplied version stamp to make workflow drift visible during durable recovery. This is an observation mechanism. It does not migrate checkpoints, pin a run to old code, or block recovery.

For execution routing by a persisted Weft revision, use the [workflow revision guide](../packages/weft/documentation/guides/workflow-revisions.md). Operative’s version stamp here is a separate diagnostic value; setting it does not enable that routing.

## Configure one value in both places

Pass the same deploy identifier to the workflow definition and the engine:

```ts
import { createRunEngine, createRunWorkflow } from '@corvidae/operative';
import type { CheckpointStore, CreateRunEngineOptions } from '@corvidae/operative';

export function startVersionedEngine(
  options: Omit<CreateRunEngineOptions, 'runWorkflow' | 'runWorkflowVersion'> & {
    checkpointStore: CheckpointStore;
  },
  workflowVersion: string,
) {
  const runWorkflow = createRunWorkflow(options.checkpointStore, {
    version: workflowVersion,
  });

  return createRunEngine({
    ...options,
    runWorkflow,
    runWorkflowVersion: workflowVersion,
    onWorkflowVersionMismatch: (event) => {
      console.warn('Durable workflow version mismatch', {
        runId: event.runId,
        storedVersion: event.storedVersion,
        registeredVersion: event.registeredVersion,
      });
    },
  });
}
```

The caller supplies the storage, its matching checkpoint store, and the live workflow services resolver through `options`. The returned engine is owned by the caller, including shutdown.

`BureauOptions.workflowVersion` is the composition-level option. When Bureau builds the durable engine, it threads that value through the workflow stamp and the recovery comparison. Omit it to disable version tracking: new cursors have no `workflowVersion`, and no mismatch event is emitted.

## Recovery behavior

At creation, the version is stored in the run's cloneable `RunCursor`. During recovery, the engine compares the stored value with `CreateRunEngineOptions.runWorkflowVersion`. A comparison happens only when both values are defined and `onWorkflowVersionMismatch` is configured. A mismatch invokes that callback with a `WorkflowVersionMismatchEvent` containing `runId`, `storedVersion`, and `registeredVersion`.

Mismatch detection itself does not cancel, fail, alter, or prevent reattachment. Recovery continues against the currently registered workflow code. The callback runs inside workflow-service resolution and must return normally; an exception from the callback can interrupt that resolution. Bureau records the observation in its recovery classification as `'reattach-version-mismatch'` instead of plain `'reattach'`, allowing a host to alert or measure drift while retaining the run's ordinary recovery behavior.

The comparison is intentionally separate from Weft's throwing workflow definition version check. A single mismatch must not abort recovery of an unrelated in-flight run in the same boot batch.

## Deploy guidance

Treat a version mismatch as a prompt to review replay compatibility. Additive changes may continue with in-flight runs, but the deploy identifier should still change so the drift is visible. A breaking change to step order, tool shape, or checkpoint interpretation can fail when an old run replays; drain or cancel those runs first, keep compatible code available, or accept ordinary run failure when the work is safely retryable.

Always derive the value from the deploy artifact or commit rather than a hand-maintained constant. Reusing the old value makes changed code appear compatible.

## Boundaries

Workflow versioning does not provide:

- per-run execution on the old code;
- checkpoint migration or schema transformation;
- deterministic replay or non-determinism detection;
- rollback of effects already committed by a tool, provider, or hook; or
- a guarantee that a mismatched run will complete successfully.

The durable workflow checkpoints a whole step—generation and tools together—so a crash can replay that step. Side-effecting tools and hooks need idempotency; the version event only tells the host that code drift exists.

## Source map

- [Workflow stamp](../packages/operative/src/durable/run-workflow-input.ts)
- [Durable engine comparison](../packages/operative/src/durable/create-run-engine.ts)
- [Cursor contract](../packages/operative/src/durable/types.ts)
- [Mismatch event](../packages/operative/src/events.ts)
- [Bureau option](../packages/bureau/src/types.ts)
- [Bureau recovery classification](../packages/bureau/src/create-bureau.ts)
