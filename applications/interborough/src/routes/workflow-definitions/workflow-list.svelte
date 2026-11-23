<script lang="ts">
  /**
   * `/workflows`: the workflows a person can read and act on, as Cinder's status-first two-line rows,
   * one each, by name (`lib/workflow-catalog.ts` says how the engine's types and the Bureau's files
   * are joined; `workflow-row.svelte` says a row). The header is "Workflows", its subtitle, and the
   * labelled primary New workflow. Segments (All, Paused, Problems) partition the rows, each with the
   * number of rows it shows, counted from the same rows (`workflow-presentation.ts`). A workflow that
   * cannot load follows ready files and comes before paused files, with its file and problem, so a
   * broken workflow is never silently missing, and a source that failed to load shows its category.
   *
   * The types Interborough registers itself to run agents, goals and its heartbeat are not
   * workflows a person starts, so a secondary "Internal workflows (N)" in the header, beside New
   * workflow, leads to a page of their own (`internal-workflows.svelte`). It counts them from the
   * same catalog, and it is not drawn while the list loads or when the engine holds none of them.
   *
   * With no workflow besides those the page is the one list-page empty state (`ListPageEmpty`): the
   * header stays, there is no filter row, the state has New workflow, Ask an agent (a new chat with
   * an agent that can create workflows) and, when the engine holds them, a way to the internal
   * workflows it names; the folder a file can be added to is behind a closed "Where workflow files
   * live" row with Copy. The frame leaves that state to this page (`pageOwnsEmptyOn` in
   * `app/views.ts`).
   */
  import {
    Button,
    DataList,
    EmptyState,
    ErrorState,
    FilterBar,
    Link,
    PageHeader,
    Skeleton,
    StaleRegion,
    Text,
  } from '@lostgradient/cinder';
  import { Search } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { tick } from 'svelte';

  import { getConnection } from '../../app/connection.svelte.ts';
  import FileLocationDetail from '../../app/file-location-detail.svelte';
  import ListPageEmpty from '../../app/list-page-empty.svelte';
  import { CONNECTION_COPY, RETRY_LABEL } from '../../app/copy/views.ts';
  import { VIEW_COPY } from '../../app/copy/view-pages.ts';
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultErrorStateAdvice } from '../../lib/faults.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { getProviders } from '../../lib/host-providers.ts';
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
      // The page draws the probe's loading and its failure (`pageOwnsLoadingOn`,
      // `pageOwnsFailureOn`), so it takes the probe's answer as it is: it never retries the load it
      // shares, and a failed load is shown, not asked again behind a skeleton. Try again asks.
      retry: false,
      retryOnMount: false,
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

  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      enabled: catalog.isSuccess && workflows.length === 0,
      retry: false,
    }),
    undefined,
  );
  const needsProvider = $derived(
    providers.data !== undefined &&
      !providers.data.providers.some((provider) => provider.connected),
  );
  const askUnavailable = $derived(
    needsProvider
      ? copy.empty.needsProvider
      : providers.isPending
        ? copy.empty.checkingProvider
        : undefined,
  );

  // The clock the dates are counted from, read again whenever the rows or their counts are.
  const now = $derived.by(() => {
    void catalog.dataUpdatedAt;
    void activity.dataUpdatedAt;
    return Date.now();
  });

  let segment = $state<ListSegment>('all');
  let search = $state('');
  let filterBar = $state<HTMLElement>();
  const counts = $derived(segmentCounts(workflows));
  const segments = $derived([
    { value: 'all', label: copy.segments.all, count: counts.all },
    { value: 'paused', label: copy.segments.paused, count: counts.paused },
    { value: 'problems', label: copy.segments.problems, count: counts.problems },
  ]);
  const visible = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    return workflows
      .filter(
        (row) =>
          inSegment(row, segment) &&
          (query === '' ||
            row.name.toLocaleLowerCase().includes(query) ||
            row.file?.title?.toLocaleLowerCase().includes(query) === true),
      )
      .map((row) => ({
        row,
        model: workflowListRow(row, activity.data?.get(row.name), now),
      }));
  });

  const newPath = workflowNewPath();
  const internalPath = internalWorkflowsPath();
  const askPath = newChatFromWorkflowsPath();
  const providersPath = '/settings/models';

  function chooseSegment(value: string): void {
    segment = value === 'paused' || value === 'problems' ? value : 'all';
  }

  async function clearFilters(): Promise<void> {
    search = '';
    segment = 'all';
    await tick();
    const localSearch = filterBar?.querySelector<HTMLInputElement>('input[type="search"]');
    if (localSearch) {
      localSearch.focus();
      return;
    }
    // The narrow and medium searches live in portalled popovers. Once a page-level Clear filters
    // button disappears, put focus on FilterBar's persistent local trigger instead.
    filterBar
      ?.querySelector<HTMLButtonElement>(
        '.cinder-filter-bar__menu-button, .cinder-filter-bar__search-button',
      )
      ?.focus();
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
      {...engineRows.length > 0 ? { actions: headerActions } : {}}
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
        {...faultErrorStateAdvice(catalog.error, () => void catalog.refetch())}
      />
    {:else if catalog.isPending}
      <Skeleton variant="list" rows={5} label={VIEW_COPY.workflows.loading.title} />
    {:else if workflows.length === 0}
      <ListPageEmpty
        view="workflows"
        title={copy.empty.title}
        description={engineRows.length > 0
          ? `${copy.empty.description} ${copy.empty.internal(engineRows.length)}`
          : copy.empty.description}
        create={{
          label: WORKFLOW_COPY.newAction,
          href: router.href(newPath),
          onclick: (event) => go(event, newPath),
        }}
        secondary={[
          {
            label: copy.empty.askAction,
            href: router.href(askPath),
            onclick: (event) => go(event, askPath),
            ...(askUnavailable === undefined ? {} : { inertReason: askUnavailable }),
          },
          ...(engineRows.length > 0
            ? [
                {
                  label: copy.empty.internalAction,
                  href: router.href(internalPath),
                  onclick: (event: MouseEvent) => go(event, internalPath),
                },
              ]
            : []),
        ]}
        data-testid="workflows-empty"
      >
        {#if needsProvider}
          <Text class="ib-workflows__provider-hint">
            {copy.empty.needsProvider}
            <Link href={router.href(providersPath)} onclick={(event) => go(event, providersPath)}>
              {copy.empty.connectProvider}
            </Link>
          </Text>
        {/if}
        <FileLocationDetail
          label={copy.empty.files.label}
          lead={copy.empty.files.lead}
          {directory}
          copyLabel={copy.empty.files.copyLabel}
          copiedLabel={copy.empty.files.copiedLabel}
          data-testid="workflows-file-location"
        />
      </ListPageEmpty>
    {:else}
      <div bind:this={filterBar}>
        <FilterBar
          aria-label={copy.segmentsLabel}
          searchQuery={search}
          searchPlaceholder={copy.searchPlaceholder}
          searchAriaLabel={copy.searchLabel}
          {segments}
          segmentValue={segment}
          onSegmentChange={chooseSegment}
          onSearchChange={(query) => (search = query)}
        />
      </div>

      {#if visible.length === 0}
        <EmptyState
          kind="filtered"
          title={copy.noMatch.title}
          description={copy.noMatch.description}
          headingLevel={2}
          clearFiltersLabel={copy.clearAction}
          onClearFilters={clearFilters}
        >
          {#snippet icon()}<Search aria-hidden="true" />{/snippet}
        </EmptyState>
      {:else}
        <div class="ib-records__bounded-list" {@attach followLinks}>
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
    {/if}
  </StaleRegion>
</section>

{#snippet headerActions()}
  <!-- The types Interborough runs itself: a secondary control beside New workflow, in every state
       that has read them (owner report, 2026-11-19). -->
  <Button
    variant="secondary"
    href={router.href(internalPath)}
    onclick={(event) => go(event, internalPath)}
    data-testid="internal-workflows-action"
  >
    {copy.internalAction(engineRows.length)}
  </Button>
{/snippet}
