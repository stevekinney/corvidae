<script lang="ts">
  /**
   * "View payload" on a failed task (row 78o): the worker's retained result in Cinder's payload
   * inspector, in a dialog. The server keeps it only for a dead-lettered task, reads it only for a
   * caller with `system:admin` (the scope that may clear it), and it is read when the dialog opens,
   * never earlier: it is the worker's raw result and may hold sensitive data. A payload over the
   * size the inspector reads inline says so instead.
   */
  import { Alert, EmptyState, Modal, PayloadInspector, Skeleton } from '@lostgradient/cinder';

  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { getPrincipalStore, isForbidden, scopeReason } from '../../lib/scopes.svelte.ts';
  import PanelFault from './panel-fault.svelte';
  import { WORKER_COPY } from './worker-copy.ts';
  import { deadLetterQuery } from './workers-data.ts';

  interface Props {
    /** The task whose payload is open, or `null` while none is. */
    readonly task: { readonly operationId: string; readonly name: string } | null;
    readonly onClose: () => void;
  }

  let { task, onClose }: Props = $props();

  const client = getClient();
  const principalStore = getPrincipalStore();
  const retained = deadLetterQuery(
    client,
    () => task?.operationId ?? '',
    () => task !== null,
  );

  // A real 403 means the credential lost the scope; record it once so the controls lock.
  $effect(() => {
    if (isForbidden(retained.error) && principalStore.hasScope('system:admin')) {
      principalStore.denyScope('system:admin');
    }
  });

  const payload = $derived(retained.data?.payload);
  const copy = WORKER_COPY.tasks;
</script>

{#if task !== null}
  <Modal open title={copy.payloadTitle(task.name)} onDismiss={onClose}>
    {#snippet children()}
      {#if retained.isPending}
        <div role="status" aria-busy="true" aria-label={copy.payloadLabel}>
          <Skeleton height="6rem" />
        </div>
      {:else if retained.error && isForbidden(retained.error)}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title="The payload is locked"
          description={`${scopeReason('system:admin')} to read the payload.`}
        />
      {:else if retained.error && faultTreatment(retained.error).kind === 'not-found'}
        <EmptyState
          kind="done"
          size="compact"
          headingLevel={3}
          title="The payload is gone"
          description="The server no longer holds this task. It may have been cleared or retried."
        />
      {:else if retained.error}
        <PanelFault error={retained.error} onRetry={() => void retained.refetch()} />
      {:else if payload?.kind === 'value'}
        <PayloadInspector value={payload.value} label={copy.payloadLabel} redact={[]} />
      {:else if payload?.kind === 'omitted'}
        <Alert variant="warning"
          >The payload is {formatBytes(payload.serializedBytes)}, over the {formatBytes(
            payload.maxBytes,
          )} this view reads inline, so it is not shown.</Alert
        >
      {:else}
        <Alert variant="info">The worker returned no payload for this task.</Alert>
      {/if}
    {/snippet}
  </Modal>
{/if}
