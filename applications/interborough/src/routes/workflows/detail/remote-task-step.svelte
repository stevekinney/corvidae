<script lang="ts">
  /**
   * The "Remote task" affordance for one timeline step (COR-274): a disclosure that opens the
   * task ledger's record for the step's dispatch.
   *
   * A settled remote step names its record (`WorkflowTimelineEntry.taskOperationId`), so the
   * disclosure is offered at once. A running step does not: its entry carries no field until it
   * settles, and the only handle is the pending activity's `token`, which is the ledger key a
   * remote `ctx.run()` enqueues under. A running step is therefore `probe`d: the ledger is asked
   * about that token, the disclosure appears only if the ledger holds a record, and nothing at
   * all renders when it does not. That is the case for a local `completeAsync()` deferral and any
   * other pending activity that was never dispatched remotely.
   */
  import { Button } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { queryKeys } from '../../../lib/query.ts';
  import { parseTaskLedgerDetail } from '../../workers/workers-data.ts';
  import RemoteActivityPanel from './remote-activity-panel.svelte';

  interface RemoteTaskStepProps {
    /** The ledger key: the entry's `taskOperationId`, or a pending activity's `token`. */
    readonly operationId: string;
    readonly label: string;
    /** Reads one task ledger record (`weft.tasks.get`). */
    readonly readTask: (input: { operationId: string }) => Promise<unknown>;
    /** True when the key is a pending token that may name no record: offer nothing until the ledger answers. */
    readonly probe: boolean;
  }

  let { operationId, label, readTask, probe }: RemoteTaskStepProps = $props();

  let open = $state(false);

  // The same key and read as the panel, so the probe and the opened panel share one request.
  const recordQuery = createQuery(() => ({
    queryKey: queryKeys.tasks.detail(operationId),
    queryFn: async () => parseTaskLedgerDetail(await readTask({ operationId })),
    retry: false,
    enabled: probe,
  }));

  const offered = $derived(!probe || recordQuery.isSuccess);
</script>

{#if offered}
  <div class="weft-remote-task-step">
    <Button
      variant="ghost"
      size="sm"
      label={`Remote task for ${label}`}
      aria-expanded={open}
      onclick={() => (open = !open)}
    />
    {#if open}
      <RemoteActivityPanel {operationId} {readTask} {label} />
    {/if}
  </div>
{/if}

<style>
  .weft-remote-task-step {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
  }
</style>
