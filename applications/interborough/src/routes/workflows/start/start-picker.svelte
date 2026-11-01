<script lang="ts">
  /**
   * `/runs?view=start`: choose the workflow to run, then go to its run setup page
   * (`/workflows/:workflow/run`), where its input and the time are set. The picker starts nothing
   * itself. It lists the workflows a person can run (`runnable-workflows.ts`), each a link to its
   * page, with a filter once the list is long, and says so when there are none, with a way to make
   * one.
   */
  import { Alert, Button, EmptyState, Input, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { GitBranch, SearchX } from '@lucide/svelte';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../../app/copy.ts';
  import { getClient } from '../../../lib/client.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { CATALOG_STALE_TIME_MS, loadCatalog } from '../../../lib/workflow-catalog.ts';
  import { workflowNewPath, workflowRunSetupPath } from '../../../lib/workflow-type-paths.ts';
  import { runnableWorkflows } from './runnable-workflows.ts';

  /** More workflows than this get a filter. */
  const FILTER_FROM = 8;

  const copy = WORKFLOW_COPY.runPicker;
  const client = getClient();

  const catalog = createQuery(() => ({
    queryKey: queryKeys.workflowCatalog.list(),
    queryFn: ({ signal }) => loadCatalog(client, { signal }),
    staleTime: CATALOG_STALE_TIME_MS,
    // A failure is said at once, with Try again, as the frame's own probe of this list does.
    retry: false,
  }));

  let filter = $state('');
  const choices = $derived(catalog.data === undefined ? [] : runnableWorkflows(catalog.data));
  const shown = $derived.by(() => {
    const words = filter.trim().toLowerCase();
    if (words === '') return choices;
    return choices.filter((row) =>
      `${row.name} ${row.description ?? ''}`.toLowerCase().includes(words),
    );
  });

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<article class="ib-run-picker" data-page="run-picker">
  <PageHeader headingLevel={1} title={copy.title} description={copy.description} />

  {#if catalog.isError}
    <Alert variant="danger">
      <p class="ib-run-picker__alert-title">{copy.loadFailedTitle}</p>
      <p class="ib-run-picker__alert-message">{copy.loadFailedDescription}</p>
      <Button variant="secondary" size="sm" onclick={() => void catalog.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if catalog.isPending}
    <div role="status" aria-busy="true" aria-label={copy.title}>
      <Skeleton height="4rem" />
    </div>
  {:else if choices.length === 0}
    <EmptyState
      kind="first-use"
      title={copy.emptyTitle}
      description={copy.emptyDescription}
      headingLevel={2}
    >
      {#snippet icon()}<GitBranch size={24} aria-hidden="true" />{/snippet}
      {#snippet action()}
        <Button
          variant="primary"
          href={router.href(workflowNewPath())}
          onclick={(event) => go(event, workflowNewPath())}>{copy.emptyAction}</Button
        >
      {/snippet}
    </EmptyState>
  {:else}
    {#if choices.length > FILTER_FROM}
      <div class="ib-run-picker__filter">
        <Input id="run-picker-filter" type="search" label={copy.filterLabel} bind:value={filter} />
      </div>
    {/if}
    {#if shown.length === 0}
      <EmptyState
        kind="filtered"
        title={copy.noMatchTitle}
        description={copy.noMatchDescription}
        headingLevel={2}
        onClearFilters={() => (filter = '')}
      >
        {#snippet icon()}<SearchX size={24} aria-hidden="true" />{/snippet}
      </EmptyState>
    {:else}
      <ul class="ib-run-picker__list" aria-label={copy.listLabel}>
        {#each shown as row (row.name)}
          <li>
            <a
              class="ib-run-picker__link"
              href={router.href(workflowRunSetupPath(row.name))}
              onclick={(event) => go(event, workflowRunSetupPath(row.name))}>{row.name}</a
            >
            {#if row.description !== null}
              <span class="ib-run-picker__description">{row.description}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <div class="ib-run-picker__actions">
      <Button variant="ghost" href={router.href('/runs')} onclick={(event) => go(event, '/runs')}
        >{copy.cancel}</Button
      >
    </div>
  {/if}
</article>

<style>
  .ib-run-picker {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .ib-run-picker__filter {
    max-width: 24rem;
  }

  .ib-run-picker__list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }

  .ib-run-picker__list > li {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    padding-block: var(--cinder-space-3);
    border-block-end: 1px solid var(--cinder-border);
    min-width: 0;
  }

  .ib-run-picker__link {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-run-picker__description {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-run-picker__actions {
    display: flex;
    gap: var(--cinder-space-2);
  }

  .ib-run-picker__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-run-picker__alert-message {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
