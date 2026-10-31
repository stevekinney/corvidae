<script lang="ts">
  /**
   * The versions of an agent-authored workflow that have run, most recently run first
   * (`bureau.workflows.revisions`). It is the Bureau's list and not the engine's: a version that
   * was saved and never ran is not on it, and nothing here activates a version, because the file
   * is what runs next. Each version carries Weft's verdict on whether it is compatible with the
   * current one, and the reasons when it is not.
   */
  import { Alert, Badge, Button, EmptyState, SectionHeading, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { listWorkflowRevisions } from '../../lib/workflow-files.ts';

  interface Props {
    /** The workflow's identifier, which is its file's. */
    id: string;
  }

  let { id }: Props = $props();

  const copy = WORKFLOW_COPY.revisions;

  const revisions = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.revisions(id),
      queryFn: ({ signal }) => listWorkflowRevisions(id, { signal }),
      retry: false,
    }),
    undefined,
  );
</script>

<section class="weft-workflow-revisions" data-testid="workflow-revisions">
  <SectionHeading level={2} title={copy.heading} description={copy.description} />
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
      size="compact"
      headingLevel={3}
      title={copy.emptyTitle}
      description={copy.emptyDescription}
    />
  {:else}
    <ul class="weft-workflow-revisions__list" aria-label={copy.caption}>
      {#each revisions.data as revision (revision.workflowVersion)}
        <li class="weft-workflow-revisions__row" data-version={revision.workflowVersion}>
          <span class="weft-workflow-revisions__version">
            {copy.versionColumn}: <code>{revision.workflowVersion}</code>
          </span>
          <span>
            {copy.firstRunColumn}:
            <time datetime={revision.firstRunAt}
              >{formatRelativeTime(Date.parse(revision.firstRunAt))}</time
            >
          </span>
          <span>
            {copy.lastRunColumn}:
            <time datetime={revision.lastRunAt}
              >{formatRelativeTime(Date.parse(revision.lastRunAt))}</time
            >
          </span>
          <span class="weft-workflow-revisions__verdict" data-testid="workflow-revision-verdict">
            {copy.verdictColumn}:
            {#if revision.compatibility === null}
              <Badge variant="neutral" size="sm">{copy.noCurrent}</Badge>
            {:else if revision.compatibility.compatible}
              <Badge variant="success" size="sm">{copy.compatible}</Badge>
            {:else}
              <Badge variant="danger" size="sm">{copy.incompatible}</Badge>
            {/if}
          </span>
          {#if revision.compatibility?.compatible === false}
            <ul class="weft-workflow-revisions__reasons" data-testid="workflow-revision-reasons">
              {#each revision.compatibility.reasons as reason (reason)}
                <li>{copy.reason(reason)}</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .weft-workflow-revisions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-workflow-revisions__failure {
    margin: 0 0 var(--cinder-space-2);
  }

  .weft-workflow-revisions__list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-workflow-revisions__row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-sm);
  }

  .weft-workflow-revisions__version {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .weft-workflow-revisions__reasons {
    flex-basis: 100%;
    margin: 0;
    padding-inline-start: var(--cinder-space-5);
    color: var(--cinder-text-secondary);
    overflow-wrap: anywhere;
  }
</style>
