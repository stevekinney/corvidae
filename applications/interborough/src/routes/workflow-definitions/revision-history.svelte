<script lang="ts">
  /**
   * The History tab of an agent-authored workflow (board PageWorkflow, "History tab", rows 62o and
   * 62p): every saved version, newest first, from `bureau.workflows.history`, run or not. Each is
   * named by its number and whether the file holds it now ("Version 1.3.0, current version"), with
   * its compatibility verdict as a neutral dot and word (amber is kept for what waits on you), what
   * changed from the version before and what it meant for the runs ("Run on this version: 1 (Fri,
   * Oct 30)"), and when it was saved. Nothing here activates a version: the file is what runs next.
   * A footnote under the list says what compatibility means.
   */
  import { Alert, Button, EmptyState, Skeleton, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { CATALOG_STALE_TIME_MS } from '../../lib/workflow-catalog.ts';
  import { listWorkflowHistory } from '../../lib/workflow-files.ts';
  import { historyRows } from './workflow-history.ts';

  interface Props {
    /** The workflow's identifier, which is its file's. */
    id: string;
  }

  let { id }: Props = $props();

  const copy = WORKFLOW_COPY.history;

  const history = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.history(id),
      queryFn: ({ signal }) => listWorkflowHistory(id, { signal }),
      // The page already read this list for the tab's count, so mounting the tab does not ask again.
      staleTime: CATALOG_STALE_TIME_MS,
      retry: false,
    }),
    undefined,
  );

  const rows = $derived(historyRows(history.data ?? []));
</script>

<section class="weft-workflow-revisions" data-testid="workflow-revisions" aria-label={copy.heading}>
  {#if history.isError}
    <Alert variant="danger">
      <p class="weft-workflow-revisions__failure">{copy.failed}</p>
      <Button variant="secondary" size="sm" onclick={() => void history.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if history.isPending}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="2rem" />
    </div>
  {:else if rows.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.emptyTitle}
      description={copy.emptyDescription}
    />
  {:else}
    <ul class="weft-workflow-revisions__list" aria-label={copy.caption}>
      {#each rows as row (row.version)}
        <li class="weft-workflow-revisions__row" data-version={row.version}>
          <div class="weft-workflow-revisions__main">
            <p class="weft-workflow-revisions__version" data-testid="workflow-revision-title">
              {#if row.verdict !== null}
                <span
                  class="weft-workflow-revisions__verdict"
                  data-testid="workflow-revision-verdict"
                  ><StatusDot status="neutral" label={row.verdict} size="sm" /></span
                >
              {/if}
              <span>{row.title}</span>
            </p>
            <p class="weft-workflow-revisions__line" data-testid="workflow-revision-line">
              {row.line}
            </p>
          </div>
          <time class="weft-workflow-revisions__saved" datetime={row.savedAtIso}>{row.savedAt}</time
          >
        </li>
      {/each}
    </ul>
    <p class="weft-workflow-revisions__footnote" data-testid="workflow-revisions-footnote">
      {copy.footnote}
    </p>
  {/if}
</section>

<style>
  .weft-workflow-revisions {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    padding-block-start: var(--cinder-space-4);
  }

  .weft-workflow-revisions__failure {
    margin: 0 0 var(--cinder-space-2);
  }

  .weft-workflow-revisions__list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* A flat row: the version and what changed at the start, when it was saved at the inline end. */
  .weft-workflow-revisions__row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cinder-space-1) var(--cinder-space-4);
    padding-block: var(--cinder-space-3);
    border-block-end: 1px solid var(--cinder-border-faint);
  }

  .weft-workflow-revisions__row:last-child {
    border-block-end: 0;
  }

  .weft-workflow-revisions__main {
    display: flex;
    flex: 1 1 20rem;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .weft-workflow-revisions__version {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2);
    min-width: 0;
    margin: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .weft-workflow-revisions__verdict {
    font-weight: 400;
  }

  .weft-workflow-revisions__line {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-workflow-revisions__saved {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .weft-workflow-revisions__footnote {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
