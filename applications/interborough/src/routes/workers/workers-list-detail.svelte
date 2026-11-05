<script lang="ts">
  /**
   * The Workers page (rows 78g, 78h, 78r, 79a, 79f and the status-first rows 78i and 78j): every
   * worker the server lists as rows in a Cinder `list-detail`, with the open worker beside it, one
   * pane at a time below the list's push width, with a Back button. The list pane is titled
   * "Workers", says how many are connected and what is running, waiting and failed for good on one
   * line (not stat cards), and has a filter that matches a worker's name, id and queue. A row is
   * the status-first two-line row every list shares: the status dot and word in the fixed column, the
   * bold name, when the worker was last heard from at the right, and line two. The open worker is
   * the `worker` parameter of the address, so a link to one worker opens it; one the server does not
   * list says so in the detail pane, with the way back to the list.
   *
   * Everything the page reads is handed in by the route (`index.svelte`), which owns the queries and
   * the writes; this component decides only how they are laid out.
   */
  import { untrack, type Snippet } from 'svelte';

  import {
    Button,
    DataList,
    EmptyState,
    ListDetail,
    RelativeTime,
    SearchField,
    StackedListItem,
    StatusDot,
  } from '@lostgradient/cinder';

  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { WorkerSummary } from './worker-catalog-types.ts';
  import { WORKER_COPY } from './worker-copy.ts';
  import {
    matchesWorkerFilter,
    orderWorkers,
    workerRowMeta,
    workerRowTime,
    workerRowTitle,
    workerStatusOf,
  } from './worker-model.ts';
  import WorkerDetailView from './worker-detail-view.svelte';

  interface Props {
    readonly workers: readonly WorkerSummary[];
    /** The line under the title: how many are connected, running, waiting, and failed for good. */
    readonly summary: string;
    readonly adminGate: ScopeGate;
    /** The open worker's queue counts; `undefined` until read. */
    readonly counts: { readonly waiting: number; readonly failed: number } | undefined;
    readonly onDrain: (worker: WorkerSummary) => void;
    readonly onResume: (workerId: string) => void;
    readonly onForget: (worker: WorkerSummary) => void;
    /** The tasks on the open worker's queue. */
    readonly queueTasks: Snippet<[worker: WorkerSummary]>;
  }

  let { workers, summary, adminGate, counts, onDrain, onResume, onForget, queueTasks }: Props =
    $props();

  const copy = WORKER_COPY;
  const selectionLocation = routerSelectionLocationFor('/health/workers');

  // The list reads the address once, when it opens; a link to another worker while this page is
  // open (the command palette, a diagnostic's worker link) is followed here.
  let selectedKey = $state<string | null>(null);
  const requested = $derived(router.search.get('worker'));
  $effect(() => {
    const next = requested;
    // Only the address drives this: a row chosen here reaches the address through the list, and
    // following the selection back would undo the choice before the address had moved.
    untrack(() => {
      if (next !== selectedKey) selectedKey = next;
    });
  });

  let filter = $state('');
  // The detail finds the open worker among every worker, so a filter that hides its row leaves it open.
  const ordered = $derived(orderWorkers(workers));
  const shown = $derived(ordered.filter((worker) => matchesWorkerFilter(worker, filter)));

  function backToList(): void {
    selectedKey = null;
  }

  /** A row's link: the address with this worker open and everything else (an open tab) kept. */
  function workerHref(worker: WorkerSummary): string {
    const search = new URLSearchParams(router.search);
    search.set('worker', worker.id);
    return router.href(`/health/workers?${search.toString()}`);
  }
</script>

<div class="weft-workers-frame" data-shortcut-region="list-detail">
  <ListDetail
    items={ordered}
    key={(worker: WorkerSummary) => worker.id}
    label={copy.list.title}
    detailLabel={copy.list.detailLabel}
    emptyTitle={copy.list.pickTitle}
    emptyDescription={copy.list.pickDescription}
    selectionParameter="worker"
    {selectionLocation}
    bind:selectedKey
    storageKey="interborough-workers"
    defaultListWidth={360}
  >
    {#snippet header()}
      <div class="ib-workers__head">
        <h2 class="ib-workers__title">{copy.list.title}</h2>
        <p class="weft-workers-frame__summary" data-testid="workers-summary">{summary}</p>
        <SearchField
          aria-label={copy.list.filterLabel}
          placeholder={copy.list.filterPlaceholder}
          size="sm"
          bind:value={filter}
          onClear={() => (filter = '')}
        />
      </div>
    {/snippet}
    {#snippet listBody({ selectedKey: openKey })}
      {#if shown.length === 0}
        <EmptyState
          kind={filter.trim() === '' ? 'first-use' : 'filtered'}
          size="compact"
          headingLevel={3}
          title={filter.trim() === ''
            ? copy.list.emptyTitle
            : copy.list.noMatchTitle(filter.trim())}
          description={filter.trim() === ''
            ? copy.list.emptyDescription
            : copy.list.noMatchDescription}
          clearFiltersLabel={copy.list.clearFilter}
          {...filter.trim() === '' ? {} : { onClearFilters: () => (filter = '') }}
        />
      {:else}
        <DataList
          items={[...shown]}
          key={(worker: WorkerSummary) => worker.id}
          statusColumn
          aria-label={copy.list.title}
        >
          {#snippet children(worker)}
            {@const rowTitle = workerRowTitle(worker)}
            <StackedListItem
              href={workerHref(worker)}
              selected={openKey === worker.id}
              tooltip={worker.id}
              metaTooltip={workerRowMeta(worker)}
              data-worker-row={worker.id}
              data-cinder-row-id={worker.id}
              data-status-word={workerStatusOf(worker)}
            >
              {#snippet status()}<StatusDot word={workerStatusOf(worker)} size="sm" />{/snippet}
              {#snippet title()}{rowTitle}{/snippet}
              {#snippet time()}<RelativeTime date={workerRowTime(worker)} seconds />{/snippet}
              {#snippet meta()}{workerRowMeta(worker)}{/snippet}
            </StackedListItem>
          {/snippet}
        </DataList>
      {/if}
    {/snippet}
    {#snippet empty()}
      {#if selectedKey !== null}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title={copy.list.closedTitle}
          description={copy.list.closedDescription(selectedKey)}
        >
          {#snippet action()}
            <Button
              variant="secondary"
              size="sm"
              label={copy.list.backToList}
              onclick={backToList}
            />
          {/snippet}
        </EmptyState>
      {:else}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title={copy.list.pickTitle}
          description={copy.list.pickDescription}
        />
      {/if}
    {/snippet}
    {#snippet detail(worker)}
      {#snippet tasksOf()}{@render queueTasks(worker)}{/snippet}
      <WorkerDetailView
        {worker}
        {workers}
        {adminGate}
        {counts}
        onDrain={() => onDrain(worker)}
        onResume={() => onResume(worker.id)}
        onForget={() => onForget(worker)}
        tasks={tasksOf}
      />
    {/snippet}
  </ListDetail>
</div>

<style>
  .ib-workers__head {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-workers__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }
</style>
