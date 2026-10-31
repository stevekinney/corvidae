<script lang="ts">
  /**
   * A run of a workflow file that the engine behind the console does not hold, drawn from the
   * Bureau's own record of it (`bureau.workflows.runs.get`). The page reads the engine by the run's
   * identifier, and a console whose engine is not the one that runs the Bureau's workflows answers
   * that read with a 404 (the end-to-end host's is a fixture engine). The Bureau answers for the
   * instance either way, so the page says what the run is instead of "No workflow found". A run the
   * Bureau does not have either is the `missing` snippet's.
   */
  import { DescriptionList, ErrorState, PayloadInspector, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { classifyFault } from '../../../lib/faults.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { getWorkflowFileRun } from '../../../lib/workflow-files.ts';
  import { workflowTypePath } from '../../../lib/workflow-type-paths.ts';
  import { workflowRunStatusWord } from '../../../lib/status.ts';
  import StatusLabel from '../../../lib/status-label.svelte';

  interface BureauRunRecordProps {
    runId: string;
    /** What to draw when the Bureau has no such run either. */
    missing: Snippet;
  }

  let { runId, missing }: BureauRunRecordProps = $props();
  const copy = TASK_COPY.runRecord;

  const run = createQuery(
    () => ({
      queryKey: queryKeys.workflows.fileRun(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getWorkflowFileRun(runId, { signal }),
      retry: false,
    }),
    undefined,
  );
  const absent = $derived(run.isError && classifyFault(run.error)?.kind === 'not-found');

  function openWorkflow(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if run.isPending}
  <div role="status" aria-busy="true" aria-label={copy.loading}>
    <Skeleton height="2rem" width="40%" />
    <Skeleton height="6rem" />
  </div>
{:else if absent}
  {@render missing()}
{:else if run.isError}
  <ErrorState
    variant="flat"
    title={copy.failed.title}
    description={copy.failed.description}
    headingLevel={2}
    retryLabel={RETRY_LABEL}
    onRetry={() => void run.refetch()}
  />
{:else}
  {@const record = run.data}
  {@const workflowHref = workflowTypePath(record.workflow)}
  <section class="ib-run-record" aria-label={copy.label} data-run-record={record.id}>
    <DescriptionList
      items={[
        { id: 'workflow', term: copy.workflow, definition: workflow },
        { id: 'status', term: copy.status, definition: status },
        { id: 'started', term: copy.started, definition: new Date(record.createdAt).toISOString() },
        { id: 'changed', term: copy.changed, definition: new Date(record.updatedAt).toISOString() },
      ]}
      variant="default"
    />
    {#snippet workflow()}
      <a href={router.href(workflowHref)} onclick={(event) => openWorkflow(event, workflowHref)}
        ><code class="ib-identifier">{record.workflow}</code></a
      >
    {/snippet}
    {#snippet status()}
      <StatusLabel word={workflowRunStatusWord(record.status)} />
    {/snippet}
    <h2 class="ib-run__heading-2">{copy.input}</h2>
    <PayloadInspector value={record.trigger} label={copy.inputPayload} />
    {#if record.result !== undefined && record.result !== null}
      <h2 class="ib-run__heading-2">{copy.result}</h2>
      <PayloadInspector value={record.result} label={copy.resultPayload} />
    {/if}
    {#if record.error !== undefined && record.error !== null}
      <h2 class="ib-run__heading-2">{copy.error}</h2>
      <p class="ib-run__note">{record.error}</p>
    {/if}
  </section>
{/if}
