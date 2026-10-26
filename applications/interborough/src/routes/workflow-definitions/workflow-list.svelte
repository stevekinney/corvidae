<script lang="ts">
  /**
   * `/workflows`: the workflows a person can read and act on, one flat row each, by name
   * (`lib/workflow-catalog.ts` says how the engine's types and the Bureau's files are joined). A
   * row says what the workflow is for, what kind it is, which agent owns it, what starts it, and
   * how busy it is (`workflow-row.svelte`). A file the Bureau cannot use is listed with its error,
   * its issues, and its path, and a source that failed to load shows the category of the failure,
   * so a broken workflow is never silently missing.
   *
   * The types the Bureau registers itself to run agents, goals, and its heartbeat are not
   * workflows a person starts, so they sit apart in a collapsed disclosure. With none besides them
   * the page says there are no workflows yet, and where one is written. New workflow opens the
   * editor that writes the first.
   */
  import { Button, Collapsible, EmptyState } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { VIEW_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    CATALOG_STALE_TIME_MS,
    loadCatalog,
    loadCodeActivity,
  } from '../../lib/workflow-catalog.ts';
  import { workflowNewPath, workflowTypePath } from '../../lib/workflow-type-paths.ts';
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

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-workflows" aria-labelledby="ib-workflows-title">
  <header class="ib-workflows__header">
    <h1 id="ib-workflows-title" class="ib-workflows__title">{VIEW_COPY.workflows.label}</h1>
    <Button
      href={router.href(newPath)}
      variant="primary"
      size="sm"
      onclick={(event) => go(event, newPath)}
    >
      <Plus size={14} aria-hidden="true" />
      {copy.newAction}
    </Button>
  </header>

  {#if catalog.isSuccess && workflows.length === 0}
    <EmptyState title={copy.list.emptyTitle} headingLevel={2} data-testid="workflows-empty">
      {#snippet action()}
        <p class="ib-workflows__empty-guide">
          {copy.list.emptyBeforeTool} <code>{copy.list.emptyTool}</code>
          {copy.list.emptyBeforeDirectory}
          <code data-testid="workflow-directory">{directory}</code>.
        </p>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="ib-workflows__list">
      {#each workflows as row (row.name)}
        <WorkflowRow
          {row}
          activity={activity.data?.get(row.name)}
          filePath={hostPaths.isPending ? undefined : workflowFilePath(directory, row.name)}
        />
      {/each}
    </ul>
  {/if}

  {#if engineRows.length > 0}
    <Collapsible trigger={copy.list.engineWorkflows(engineRows.length)} variant="flat">
      <p class="ib-workflows__engine-note">{copy.list.engineDescription}</p>
      <ul class="ib-workflows__list">
        {#each engineRows as row (row.name)}
          <li class="ib-workflow-row" data-workflow={row.name} data-kind="code" data-engine>
            <a
              class="ib-workflow-name"
              href={router.href(workflowTypePath(row.name))}
              onclick={(event) => go(event, workflowTypePath(row.name))}>{row.name}</a
            >
          </li>
        {/each}
      </ul>
    </Collapsible>
  {/if}
</section>
