<script lang="ts">
  /**
   * `/internal-workflows`: the workflow types Interborough registers itself to carry out agent
   * runs, goals and its heartbeat (`RUN_ENGINE_WORKFLOW_TYPES`). Nobody starts one by hand, so they
   * are not in the list of workflows; this page lists them, each with a line on what it does and a
   * link to its page, and `/workflows` links here. A name such as `durableHeartbeatTick` is code, so it
   * reads as "Durable Heartbeat Tick" with the identifier beside it. It reads the same catalog the list reads.
   */
  import {
    Button,
    EmptyState,
    ErrorState,
    humanizeIdentifier,
    PageHeader,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { CATALOG_STALE_TIME_MS, loadCatalog } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';

  const client = getClient();
  const copy = WORKFLOW_COPY.internal;
  const WORKFLOWS_PATH = '/workflows';

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.list(),
      queryFn: ({ signal }) => loadCatalog(client, { signal }),
      staleTime: CATALOG_STALE_TIME_MS,
      retry: false,
    }),
    undefined,
  );
  const rows = $derived((catalog.data ?? []).filter((row) => row.engine));

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

  {#snippet backToWorkflows()}
    <Button
      href={router.href(WORKFLOWS_PATH)}
      variant="ghost"
      size="sm"
      onclick={(event) => go(event, WORKFLOWS_PATH)}>{copy.backToWorkflows}</Button
    >
  {/snippet}
  <RecordsToolbar count={copy.count(rows.length)} action={backToWorkflows} />

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
    <Table caption={copy.caption} density="condensed">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.columns.workflow}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.description}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as row (row.name)}
          <Table.Row data-workflow={row.name} data-engine>
            <Table.Cell class="ib-records__wrap">
              <a
                class="ib-workflow-name"
                href={router.href(workflowTypePath(row.name))}
                onclick={(event) => go(event, workflowTypePath(row.name))}
                >{humanizeIdentifier(row.name)}</a
              >
              <code class="ib-identifier" data-testid="workflow-identifier">{row.name}</code>
            </Table.Cell>
            <Table.Cell class="ib-records__wrap" data-testid="workflow-description"
              >{row.description ?? copy.noDescription}</Table.Cell
            >
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
</section>
