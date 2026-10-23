<script lang="ts">
  /**
   * `/workflows`: every workflow the engine can run and every workflow file the Bureau holds, in
   * one list, by name (`lib/workflow-catalog.ts` says how they are joined). A file the Bureau cannot
   * use is listed with its error, its issues, and its path, and a source that failed to load shows
   * the category of the failure, so a broken workflow is never silently missing.
   */
  import { Badge, CodeLocation } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { VIEW_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { CATALOG_STALE_TIME_MS, loadCatalog } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import FileProblem from './file-problem.svelte';
  import { rowBadges, rowState } from './workflow-presentation.ts';

  const client = getClient();

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.list(),
      queryFn: ({ signal }) => loadCatalog(client, { signal }),
      // The frame's probe loaded it a moment ago, under this key.
      staleTime: CATALOG_STALE_TIME_MS,
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
  const directory = $derived(hostPaths.data?.workflowDirectory ?? WORKFLOW_COPY.fallbackDirectory);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="weft-workflow-catalog" aria-labelledby="weft-workflow-catalog-title">
  <h1 id="weft-workflow-catalog-title" class="weft-workflow-catalog__title">
    {VIEW_COPY.workflows.label}
  </h1>
  <ul class="weft-workflow-catalog__list">
    {#each catalog.data ?? [] as row (row.name)}
      {@const path = workflowTypePath(row.name)}
      <li
        class="weft-workflow-catalog__row"
        data-workflow={row.name}
        data-kind={row.kind}
        data-state={rowState(row)}
      >
        <div class="weft-workflow-catalog__identity">
          <a
            class="weft-workflow-catalog__name"
            href={router.href(path)}
            onclick={(event) => go(event, path)}>{row.name}</a
          >
          {#if row.description}
            <p class="weft-workflow-catalog__description">{row.description}</p>
          {/if}
          {#if row.problem !== null}
            <FileProblem problem={row.problem} />
          {/if}
          {#if row.file !== null && row.file.state === 'invalid' && !hostPaths.isPending}
            <CodeLocation
              file={workflowFilePath(directory, row.name)}
              data-testid="workflow-file-path"
            />
          {/if}
        </div>
        <div class="weft-workflow-catalog__badges">
          {#each rowBadges(row) as badge (badge.label)}
            <span data-testid={badge.testId}>
              <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
            </span>
          {/each}
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .weft-workflow-catalog {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .weft-workflow-catalog__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
  }

  .weft-workflow-catalog__list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-workflow-catalog__row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface-raised);
  }

  .weft-workflow-catalog__identity {
    display: flex;
    flex: 1 1 280px;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .weft-workflow-catalog__name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .weft-workflow-catalog__description {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-workflow-catalog__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
</style>
