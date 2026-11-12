<script lang="ts">
  /**
   * `/internal-workflows` ("Workflows › Internal"): the workflow types Interborough registers itself
   * to carry out chats, goals and its heartbeat (`RUN_ENGINE_WORKFLOW_TYPES`). Nobody starts one by
   * hand, so they are not in the list of workflows; the card at the foot of `/workflows` leads here.
   * The page is an operator table in its own bordered box (the one place Workflows keeps a table),
   * with what each type is called, what it does, how many times it has run and when it last did.
   * It has no Start run, Edit or Pause action and no "+": a name goes to that workflow's runs, and
   * the code name under it is not a link. It reads the same catalog the list reads, and the counts
   * apart from it (`loadInternalActivity`), so a count the engine would not give is left blank,
   * never shown as zero. With none registered it says why in terms of the engine it talks to.
   */
  import { EmptyState, ErrorState, Link, PageHeader, Skeleton, Table } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    CATALOG_STALE_TIME_MS,
    loadCatalog,
    loadInternalActivity,
  } from '../../lib/workflow-catalog.ts';
  import { workflowRunsPath } from '../../lib/workflow-type-paths.ts';
  import { internalCells, internalWords, sortInternalRows } from './workflow-presentation.ts';

  const client = getClient();
  const copy = WORKFLOW_COPY.internal;

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.list(),
      queryFn: ({ signal }) => loadCatalog(client, { signal }),
      staleTime: CATALOG_STALE_TIME_MS,
      retry: false,
    }),
    undefined,
  );
  const engineRows = $derived((catalog.data ?? []).filter((row) => row.engine));
  const rows = $derived(sortInternalRows(engineRows));
  const names = $derived(engineRows.map((row) => row.name));

  // How often each type has run is read apart from the list of types, so the rows never wait on it.
  const activity = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.internalActivity(names),
      queryFn: () => loadInternalActivity(client, names),
      enabled: catalog.isSuccess && names.length > 0,
      retry: false,
    }),
    undefined,
  );

  // The clock the last runs are counted from, read again whenever the counts are.
  const now = $derived.by(() => {
    void activity.dataUpdatedAt;
    return Date.now();
  });

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-workflows ib-records" aria-label={copy.title} data-page="internal-workflows">
  <PageHeader title={copy.title} headingLevel={1} description={copy.description} />

  {#if catalog.isPending}
    <div role="status" aria-busy="true" aria-label={copy.title}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if catalog.isError && catalog.data === undefined}
    <ErrorState
      variant="flat"
      title={copy.loadFailed.title}
      description={copy.loadFailed.description}
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      onRetry={() => void catalog.refetch()}
    />
  {:else if rows.length === 0}
    <EmptyState
      kind="first-use"
      title={copy.empty.title}
      description={copy.empty.description}
      headingLevel={2}
    />
  {:else}
    <Table caption={copy.caption} density="condensed" class="ib-records__table">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.columns.workflow}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.description}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.runs}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.lastRun}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as row (row.name)}
          {@const words = internalWords(row.name, row.description)}
          {@const cells = internalCells(activity.data?.get(row.name), now)}
          <Table.Row data-workflow={row.name} data-engine>
            <Table.Cell class="ib-records__wrap">
              <Link
                href={router.href(workflowRunsPath(row.name))}
                onclick={(event) => go(event, workflowRunsPath(row.name))}>{words.title}</Link
              >
              <code class="ib-identifier ib-workflows__code-name" data-testid="workflow-identifier"
                >{row.name}</code
              >
            </Table.Cell>
            <Table.Cell class="ib-records__wrap" data-testid="workflow-description"
              >{words.description ?? copy.noDescription}</Table.Cell
            >
            <Table.Cell data-testid="workflow-run-counts">{cells.runs ?? ''}</Table.Cell>
            <Table.Cell data-testid="workflow-last-run">{cells.lastRun ?? ''}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
</section>
