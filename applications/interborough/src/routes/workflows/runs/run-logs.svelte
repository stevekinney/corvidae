<script lang="ts">
  /**
   * Every line the run logged, under the run's Details, oldest first. The same lines appear in the
   * step each was logged before; this is the whole log, including the lines after the last step.
   * They are read from the engine's log store, which keeps them with the run, so a finished run
   * still has them after the host restarts. Closed until asked for, because a busy run logs a lot.
   */
  import { Alert, Collapsible, EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, RUN_LOGS_COPY } from '../../../app/copy.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import LogLines from '../detail/steps/log-lines.svelte';
  import {
    LOGS_OPERATION,
    fetchRunLogs,
    workflowLogsQueryKey,
    type LogsClient,
  } from '../detail/steps/step-logs.ts';

  interface RunLogsProps {
    readonly client: LogsClient;
    readonly workflowId: string;
  }

  let { client, workflowId }: RunLogsProps = $props();

  let open = $state(false);

  const offered = $derived(client.operations[LOGS_OPERATION] !== undefined);
  const logs = createQuery(() => ({
    queryKey: workflowLogsQueryKey(workflowId),
    queryFn: () => fetchRunLogs(client, workflowId),
    enabled: offered,
  }));
  // The query notifies only for the fields the page has read, and a closed section reads none of
  // them until it opens, so `status` is read by the section itself (`data-state`) as well: an
  // answer that arrives while the section is being opened would otherwise leave it showing the wait.
  const phase = $derived(logs.status);
  const failure = $derived(phase === 'error' ? faultTreatment(logs.error) : undefined);
  const trigger = $derived(
    logs.data === undefined
      ? RUN_LOGS_COPY.heading
      : `${RUN_LOGS_COPY.heading} · ${RUN_LOGS_COPY.count(logs.data.lines.length)}`,
  );
</script>

{#if offered}
  <section
    class="ib-run-logs"
    aria-label={RUN_LOGS_COPY.heading}
    data-section="logs"
    data-state={logs.status}
  >
    <Collapsible bind:open {trigger}>
      {#if phase === 'pending'}
        <Skeleton height="4rem" />
      {:else if phase === 'error'}
        <ErrorState
          variant="flat"
          title={RUN_LOGS_COPY.loadFailedTitle}
          description={failure?.message ?? ''}
          headingLevel={3}
          retryLabel={RETRY_LABEL}
          onRetry={() => void logs.refetch()}
        />
      {:else if logs.data === undefined || logs.data.lines.length === 0}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={RUN_LOGS_COPY.emptyTitle}
          description={RUN_LOGS_COPY.emptyDescription}
        />
      {:else}
        {#if logs.data.dropped > 0}
          <Alert variant="info">{RUN_LOGS_COPY.dropped(logs.data.dropped)}</Alert>
        {/if}
        <LogLines lines={logs.data.lines} label={RUN_LOGS_COPY.listLabel} />
      {/if}
    </Collapsible>
  </section>
{/if}

<style>
  .ib-run-logs {
    min-width: 0;
  }
</style>
