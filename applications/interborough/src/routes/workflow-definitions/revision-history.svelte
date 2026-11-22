<script lang="ts">
  /**
   * Every saved version of an agent-authored workflow, newest first (`bureau.workflows.history`).
   */
  import { Alert, Button, CopyButton, EmptyState, Skeleton, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { dayAndTime } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { CATALOG_STALE_TIME_MS } from '../../lib/workflow-catalog.ts';
  import { listWorkflowSavedVersions } from '../../lib/workflow-files.ts';
  import { savedChangeSummary } from './workflow-impact.ts';

  interface Props {
    /** The workflow's identifier, which is its file's. */
    id: string;
  }

  let { id }: Props = $props();

  const copy = WORKFLOW_COPY.revisions;

  const revisions = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.savedVersions(id),
      queryFn: ({ signal }) => listWorkflowSavedVersions(id, { signal }),
      // The page already read this list for the tab's count, so mounting the tab does not ask again.
      staleTime: CATALOG_STALE_TIME_MS,
      retry: false,
    }),
    undefined,
  );
</script>

<section class="weft-workflow-revisions" data-testid="workflow-revisions" aria-label={copy.heading}>
  {#if revisions.isError}
    <Alert variant="danger">
      <p class="weft-workflow-revisions__failure">{copy.failed}</p>
      <Button variant="secondary" size="sm" onclick={() => void revisions.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if revisions.isPending}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="2rem" />
    </div>
  {:else if revisions.data.length === 0}
    <EmptyState
      kind="first-use"
      headingLevel={3}
      title={copy.emptyTitle}
      description={copy.emptyDescription}
    />
  {:else}
    <ul class="weft-workflow-revisions__list" aria-label={copy.caption}>
      {#each revisions.data as revision (revision.version)}
        {@const summary = savedChangeSummary(revision)}
        <li class="weft-workflow-revisions__row" data-version={revision.workflowVersion}>
          <p class="weft-workflow-revisions__version" data-testid="workflow-revision-title">
            <span
              >{`Version ${revision.version}, ${revision.current ? copy.current : copy.older}`}</span
            >
            <CopyButton value={revision.hash} label={copy.copyVersion(revision.version)} />
          </p>
          <p class="weft-workflow-revisions__line" data-testid="workflow-revision-verdict">
            {#if revision.compatibility === 'compatible'}
              <StatusDot status="neutral" label={copy.compatible} />
            {:else if revision.compatibility === 'breaking'}
              <StatusDot status="neutral" label={copy.incompatible} />
            {:else}
              <StatusDot status="neutral" label={copy.noComparison} />
            {/if}
            {', '}<time datetime={revision.savedAt}
              >{copy.saved(dayAndTime(Date.parse(revision.savedAt), Date.now()))}</time
            >
          </p>
          {#if summary !== undefined}
            <p class="weft-workflow-revisions__line">{summary}</p>
          {/if}
          {#if revision.current && revision.compatibility === 'compatible'}
            <p class="weft-workflow-revisions__line">{copy.runsKeepGoing}</p>
          {/if}
          {#if revision.runs !== null}
            <p class="weft-workflow-revisions__line">
              {revision.runs.count === 0
                ? copy.noRunsOnVersion
                : copy.runsOnVersion(
                    revision.runs.count,
                    revision.runs.lastRunAt === null
                      ? undefined
                      : dayAndTime(Date.parse(revision.runs.lastRunAt), Date.now()),
                  )}
            </p>
          {/if}
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

  .weft-workflow-revisions__row {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    padding-block: var(--cinder-space-3);
    border-block-end: 1px solid var(--cinder-border-faint);
  }

  .weft-workflow-revisions__row:last-child {
    border-block-end: 0;
  }

  .weft-workflow-revisions__version {
    min-width: 0;
    margin: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  /* Prose, not a flex row: a flex item drops the space that follows the comma after the verdict. */
  .weft-workflow-revisions__line {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-workflow-revisions__footnote {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
