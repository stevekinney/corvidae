<script lang="ts">
  /**
   * `/workflows`: the workflows a person can read and act on, as a table with one row each, by name
   * (`lib/workflow-catalog.ts` says how the engine's types and the Bureau's files are joined). A
   * row says what the workflow is for, what kind it is, which agent owns it, what starts it, how
   * busy it is, and its status in one of the seven words (`workflow-row.svelte`). A file the Bureau
   * cannot use is listed with its error, its issues, and its path, and a source that failed to load
   * shows the category of the failure, so a broken workflow is never silently missing. The toolbar
   * under the heading has the count, a search and a status filter, New workflow, and a link to the
   * internal workflows.
   *
   * The types the Bureau registers itself to run agents, goals, and its heartbeat are not
   * workflows a person starts, so they have a page of their own (`internal-workflows.svelte`), linked
   * from here. With none besides them the page says there are no workflows yet, and where one is
   * written. New workflow opens the editor that writes the first.
   */
  import { Button, EmptyState, FilterBar, PageHeader, Table } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { VIEW_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { getClient } from '../../lib/client.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    CATALOG_STALE_TIME_MS,
    loadCatalog,
    loadCodeActivity,
  } from '../../lib/workflow-catalog.ts';
  import { STATUS_WORDS } from '../../lib/status.ts';
  import { internalWorkflowsPath, workflowNewPath } from '../../lib/workflow-type-paths.ts';
  import { workflowRowStatus } from './workflow-presentation.ts';
  import WorkflowRow from './workflow-row.svelte';

  const client = getClient();
  const copy = WORKFLOW_COPY;

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
  const engineRows = $derived(rows.filter((row) => row.engine));
  const workflows = $derived(rows.filter((row) => !row.engine));
  const codeNames = $derived(workflows.filter((row) => row.kind === 'code').map((row) => row.name));

  // What the engine says of the code-defined types is read apart from the list, because a count
  // the engine would not give must not hold the rows back.
  const activity = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.activity(codeNames),
      queryFn: () => loadCodeActivity(client, codeNames),
      enabled: catalog.isSuccess && codeNames.length > 0,
      retry: false,
    }),
    undefined,
  );

  // Where the files are. A host that does not say shows the path relative to the state directory.
  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      // A host that does not say is not asked again: the fallback path is shown instead.
      retry: false,
    }),
    undefined,
  );
  const directory = $derived(hostPaths.data?.workflowDirectory ?? copy.fallbackDirectory);

  const newPath = workflowNewPath();
  const internalPath = internalWorkflowsPath();

  // The search narrows the names and descriptions on screen; the status narrows by the row's word.
  let search = $state('');
  let statusFilter = $state('');
  const needle = $derived(search.trim().toLowerCase());
  const visible = $derived(
    workflows.filter(
      (row) =>
        (needle === '' ||
          row.name.toLowerCase().includes(needle) ||
          (row.description ?? '').toLowerCase().includes(needle)) &&
        (statusFilter === '' ||
          workflowRowStatus(row, activity.data?.get(row.name)) === statusFilter),
    ),
  );
  const filtered = $derived(needle !== '' || statusFilter !== '');
  const facets = [
    {
      type: 'select' as const,
      key: 'status',
      label: copy.list.statusLabel,
      placeholder: copy.list.anyStatus,
      options: STATUS_WORDS.map((word) => ({ value: word, label: word })),
    },
  ];
  const appliedFilters = $derived(
    statusFilter === ''
      ? []
      : [
          {
            key: 'status',
            value: statusFilter,
            label: copy.list.statusLabel,
          },
        ],
  );

  function clearFilters(): void {
    search = '';
    statusFilter = '';
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
  <PageHeader title={VIEW_COPY.workflows.label} headingLevel={1} />

  {#snippet filterBar()}
    <FilterBar
      aria-label={copy.list.filtersLabel}
      searchQuery={search}
      searchPlaceholder={copy.list.searchPlaceholder}
      searchAriaLabel={copy.list.searchLabel}
      {facets}
      {appliedFilters}
      onSearchChange={(query) => (search = query)}
      onFacetChange={(_key, value) => (statusFilter = value)}
      onFilterRemove={() => (statusFilter = '')}
      onClearAll={clearFilters}
    />
  {/snippet}
  {#snippet toolbarActions()}
    <Button
      href={router.href(internalPath)}
      variant="ghost"
      size="sm"
      onclick={(event) => go(event, internalPath)}
      data-testid="internal-workflows-link">{copy.list.internalWorkflows(engineRows.length)}</Button
    >
    <Button
      href={router.href(newPath)}
      variant="primary"
      size="sm"
      onclick={(event) => go(event, newPath)}
    >
      <Plus size={14} aria-hidden="true" />
      {copy.newAction}
    </Button>
  {/snippet}
  <RecordsToolbar
    count={copy.list.count(visible.length)}
    filters={filterBar}
    action={toolbarActions}
  />

  {#if catalog.isSuccess && workflows.length === 0}
    <EmptyState
      kind="first-use"
      title={copy.list.emptyTitle}
      headingLevel={2}
      data-testid="workflows-empty"
    >
      {#snippet action()}
        <p class="ib-workflows__empty-guide">
          {copy.list.emptyBeforeTool} <code>{copy.list.emptyTool}</code>
          {copy.list.emptyBeforeDirectory}
          <code data-testid="workflow-directory">{directory}</code>.
        </p>
      {/snippet}
    </EmptyState>
  {:else if catalog.isSuccess && visible.length === 0 && filtered}
    <EmptyState
      kind="filtered"
      title={copy.list.noMatch.title}
      description={copy.list.noMatch.description}
      headingLevel={2}
      clearFiltersLabel={copy.list.clearAction}
      onClearFilters={clearFilters}
    />
  {:else}
    <Table caption={copy.listLabel} density="condensed">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.list.columns.workflow}</Table.HeaderCell>
          <Table.HeaderCell>{copy.list.columns.kind}</Table.HeaderCell>
          <Table.HeaderCell>{copy.list.columns.starts}</Table.HeaderCell>
          <Table.HeaderCell>{copy.list.columns.runs}</Table.HeaderCell>
          <Table.HeaderCell>{copy.list.columns.status}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each visible as row (row.name)}
          <WorkflowRow
            {row}
            activity={activity.data?.get(row.name)}
            filePath={hostPaths.isPending ? undefined : workflowFilePath(directory, row.name)}
          />
        {/each}
      </Table.Body>
    </Table>
  {/if}
</section>
