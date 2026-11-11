<script lang="ts">
  /**
   * `/workflows`: the workflows a person can read and act on, as Cinder's status-first two-line rows,
   * one each, by name (`lib/workflow-catalog.ts` says how the engine's types and the Bureau's files
   * are joined; `workflow-row.svelte` says a row). The header is "Workflows", its subtitle, and the
   * secondary "+" that makes one. Segments (All, Paused, Problems) partition the rows, each with the
   * number of rows it shows, counted from the same rows (`workflow-presentation.ts`). A workflow that
   * cannot load is listed first with its file and its problem, so a broken workflow is never silently
   * missing, and a source that failed to load shows the category of the failure.
   *
   * The types Interborough registers itself to run agents, goals and its heartbeat are not
   * workflows a person starts, so one card below the rows leads to a page of their own
   * (`internal-workflows.svelte`). It counts them from the same catalog, and it is not drawn while
   * the list loads, while there is nothing to list, or when the engine holds none of them.
   *
   * With no workflow besides those the page is its empty state: the header stays, there is no filter
   * row and no Internal workflows card, two actions (New workflow, and Ask an agent to write one,
   * which opens a new chat with an agent that can create workflows), and a line saying where a file
   * can be added. The frame leaves that state to this page (`pageOwnsEmptyOn` in `app/views.ts`).
   */
  import {
    Button,
    Card,
    DataList,
    EmptyState,
    ErrorState,
    FilterBar,
    PageHeader,
    Skeleton,
    StaleRegion,
  } from '@lostgradient/cinder';
  import { ChevronRight, MessageSquare, Plus, Search, Workflow } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { CONNECTION_COPY, RETRY_LABEL, VIEW_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { newChatFromWorkflowsPath } from '../../lib/new-chat-address.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    CATALOG_STALE_TIME_MS,
    loadCatalog,
    loadCodeActivity,
  } from '../../lib/workflow-catalog.ts';
  import { internalWorkflowsPath, workflowNewPath } from '../../lib/workflow-type-paths.ts';
  import {
    inSegment,
    segmentCounts,
    sortListRows,
    workflowListRow,
    type ListSegment,
  } from './workflow-presentation.ts';
  import WorkflowRow from './workflow-row.svelte';

  const client = getClient();
  const connection = getConnection();
  const copy = WORKFLOW_COPY.list;

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.list(),
      queryFn: ({ signal }) => loadCatalog(client, { signal }),
      // The frame's probe loaded it a moment ago, under this key.
      staleTime: CATALOG_STALE_TIME_MS,
    }),
    undefined,
  );

  const rows = $derived(catalog.data ?? []);
  // The types Interborough runs itself are counted for the card, and are never rows of the list.
  const engineRows = $derived(rows.filter((row) => row.engine));
  const workflows = $derived(sortListRows(rows.filter((row) => !row.engine)));
  // The types the engine counts for the list: those code registered, and the files the Bureau cannot
  // use, which it does not count itself.
  const codeNames = $derived(
    workflows
      .filter((row) => row.kind === 'code' || row.file?.state === 'invalid')
      .map((row) => row.name),
  );

  // What the engine says of those types is read apart from the list, because a count the engine
  // would not give must not hold the rows back.
  const activity = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.activity(codeNames),
      queryFn: () => loadCodeActivity(client, codeNames),
      enabled: catalog.isSuccess && codeNames.length > 0,
      retry: false,
    }),
    undefined,
  );

  // Where the files are, for the hint of the empty state. A host that does not say is not asked
  // again, and the hint names the usual place.
  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );
  const directory = $derived(hostPaths.data?.workflowDirectory ?? copy.empty.hintDirectory);

  // The clock the dates are counted from, read again whenever the rows or their counts are.
  const now = $derived.by(() => {
    void catalog.dataUpdatedAt;
    void activity.dataUpdatedAt;
    return Date.now();
  });

  let segment = $state<ListSegment>('all');
  const counts = $derived(segmentCounts(workflows));
  const segments = $derived([
    { value: 'all', label: copy.segments.all, count: counts.all },
    { value: 'paused', label: copy.segments.paused, count: counts.paused },
    { value: 'problems', label: copy.segments.problems, count: counts.problems },
  ]);
  const visible = $derived(
    workflows
      .filter((row) => inSegment(row, segment))
      .map((row) => ({
        row,
        model: workflowListRow(row, activity.data?.get(row.name), now),
      })),
  );

  const newPath = workflowNewPath();
  const internalPath = internalWorkflowsPath();
  const askPath = newChatFromWorkflowsPath();

  function chooseSegment(value: string): void {
    segment = value === 'paused' || value === 'problems' ? value : 'all';
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-workflows ib-records" aria-label={VIEW_COPY.workflows.label}>
  <!-- While the server gives no answer the shell holds every control that changes something; this
       region is how the header's "+" (and the empty state's button) join them. Rows stay live links. -->
  <StaleRegion
    stale={connection.unreachable}
    reason={CONNECTION_COPY.changesOff}
    class="ib-workflows__body"
  >
    <PageHeader
      title={VIEW_COPY.workflows.label}
      description={copy.subtitle}
      headingLevel={1}
      error={catalog.isError && catalog.data === undefined}
      createAction={{
        label: WORKFLOW_COPY.newAction,
        href: router.href(newPath),
        onclick: (event) => go(event, newPath),
      }}
    />

    {#if catalog.isError && catalog.data === undefined}
      <ErrorState
        bordered
        title={VIEW_COPY.workflows.error.title}
        description={VIEW_COPY.workflows.error.description}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        onRetry={() => void catalog.refetch()}
      />
    {:else if catalog.isPending}
      <Skeleton variant="list" rows={5} label={VIEW_COPY.workflows.loading.title} />
    {:else if workflows.length === 0}
      <EmptyState
        bordered
        kind="first-use"
        title={copy.empty.title}
        description={copy.empty.description}
        headingLevel={2}
        data-testid="workflows-empty"
      >
        {#snippet icon()}<Workflow aria-hidden="true" />{/snippet}
        {#snippet action()}
          <div class="ib-workflows__empty-actions">
            <Button
              variant="primary"
              href={router.href(newPath)}
              onclick={(event) => go(event, newPath)}
              mutating
            >
              {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
              {WORKFLOW_COPY.newAction}
            </Button>
            <Button
              variant="ghost"
              href={router.href(askPath)}
              onclick={(event) => go(event, askPath)}
            >
              {#snippet leadingIcon()}<MessageSquare aria-hidden="true" />{/snippet}
              {copy.empty.askAction}
            </Button>
          </div>
        {/snippet}
      </EmptyState>
      <p class="ib-workflows__hint" data-testid="workflows-empty-hint">
        {copy.empty.hintBefore}
        <code class="ib-identifier" data-testid="workflow-directory">{directory}</code>
      </p>
    {:else}
      <FilterBar
        aria-label={copy.segmentsLabel}
        searchVisible={false}
        {segments}
        segmentValue={segment}
        onSegmentChange={chooseSegment}
      />

      {#if visible.length === 0}
        <EmptyState
          bordered
          kind="filtered"
          title={copy.noMatch.title}
          description={copy.noMatch.description}
          headingLevel={2}
          clearFiltersLabel={copy.clearAction}
          onClearFilters={() => (segment = 'all')}
        >
          {#snippet icon()}<Search aria-hidden="true" />{/snippet}
        </EmptyState>
      {:else}
        <div {@attach followLinks}>
          <DataList
            items={visible}
            key={(item) => item.row.name}
            statusColumn
            aria-label={copy.rowsLabel}
          >
            {#snippet children(item)}
              <WorkflowRow row={item.row} model={item.model} />
            {/snippet}
          </DataList>
        </div>
      {/if}

      {#if engineRows.length > 0}
        <Card
          edge="border"
          href={router.href(internalPath)}
          onclick={(event) => go(event, internalPath)}
          data-testid="internal-workflows-card"
          header={cardHeader}
          children={cardBody}
        />
      {/if}
    {/if}
  </StaleRegion>
</section>

{#snippet cardHeader()}
  <div class="ib-workflows__card-title">
    <h2 class="ib-workflows__card-heading">{copy.internalCard.title}</h2>
    <span class="ib-workflows__card-count" data-testid="internal-workflows-count"
      >{copy.internalCard.count(engineRows.length)}</span
    >
    <ChevronRight class="ib-workflows__card-chevron" aria-hidden="true" />
  </div>
{/snippet}

{#snippet cardBody()}
  <p class="ib-workflows__card-description">{copy.internalCard.description}</p>
{/snippet}
