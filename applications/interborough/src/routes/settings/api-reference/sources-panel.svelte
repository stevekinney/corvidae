<script lang="ts">
  /**
   * The Workflow sources tab (board PageSettingsSections, "API reference, Workflow sources"): where
   * Interborough reads workflow files from, read-only. Each file is listed by its path with what it
   * holds: how many workflows, their names, and how many schedules. A workflow is edited in its
   * file, and "Open file" belongs on each workflow, so there is none here. The tab draws nothing
   * under the list.
   */
  import { humanizeIdentifier } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { API_REFERENCE_COPY } from '../../../app/copy.ts';
  import { listWorkflowFiles } from '../../../lib/workflow-files.ts';
  import { getHostPaths, workflowFilePath } from '../../../lib/host-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { failureStatusOf } from './failure-status.ts';
  import LoadState from './load-state.svelte';

  const queryClient = useQueryClient();
  const copy = API_REFERENCE_COPY.sources;
  const QUERY_KEY = ['api-reference', 'workflow-files'] as const;

  const files = createQuery(
    () => ({
      queryKey: QUERY_KEY,
      queryFn: ({ signal }) => listWorkflowFiles({ signal }),
      retry: false,
    }),
    undefined,
  );
  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );

  let canceled = $state(false);

  /** What a file holds, in the words under its path: "1 workflow, Order refund, 1 schedule". */
  function holds(file: { id: string; trigger: Record<string, unknown> | null }): string {
    const schedules = file.trigger?.['kind'] === 'schedule' ? 1 : 0;
    const base = `${copy.workflows(1)}, ${humanizeIdentifier(file.id, { casing: 'sentence' })}`;
    return schedules === 0 ? base : `${base}, ${copy.schedules(schedules)}`;
  }

  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: QUERY_KEY });
  }

  function tryAgain(): void {
    canceled = false;
    void files.refetch();
  }

  const failureStatus = $derived(failureStatusOf(files.error));
</script>

<div class="ib-sources" data-testid="api-sources">
  {#if files.data !== undefined}
    <p class="ib-sources__intro">{copy.intro}</p>
    {#if files.data.length === 0}
      <p class="ib-sources__muted">{copy.empty}</p>
    {:else}
      <ul class="ib-sources__list" aria-label={copy.listLabel}>
        {#each files.data as file (file.id)}
          <li data-workflow-file={file.id}>
            <code
              class="ib-sources__path"
              title={hostPaths.data === undefined
                ? undefined
                : workflowFilePath(hostPaths.data.workflowDirectory, file.id)}
              >workflows/{file.id}.json</code
            >
            <span class="ib-sources__holds">{holds(file)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <LoadState
      kind={files.isError ? 'error' : canceled ? 'canceled' : 'loading'}
      status={failureStatus}
      onCancel={cancelLoading}
      onRetry={tryAgain}
    />
  {/if}
</div>

<style>
  .ib-sources {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-sources__intro,
  .ib-sources__muted {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .ib-sources__muted {
    color: var(--cinder-text-muted);
  }

  .ib-sources__list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }

  .ib-sources__list > li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2) var(--cinder-space-4);
    align-items: baseline;
    justify-content: space-between;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
  }

  .ib-sources__list > li + li {
    border-block-start: 1px solid var(--cinder-border-muted);
  }

  .ib-sources__path {
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .ib-sources__holds {
    color: var(--cinder-text-muted);
  }
</style>
