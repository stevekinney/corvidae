<script lang="ts">
  /**
   * The versions of an agent-authored workflow that have run, most recently run first
   * (`bureau.workflows.revisions`). It is the Bureau's list and not the engine's: a version that
   * was saved and never ran is not on it, and nothing here activates a version, because the file
   * is what runs next.
   */
  import { Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
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
  <h2 class="weft-workflow-section__heading">{copy.heading}</h2>
  <p class="weft-workflow-revisions__description">{copy.description}</p>
  {#if revisions.isError}
    <p role="alert">{copy.failed}</p>
  {:else if revisions.isPending}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="2rem" />
    </div>
  {:else if revisions.data.length === 0}
    <p class="weft-workflow-revisions__none">{copy.empty}</p>
  {:else}
    <ul class="weft-workflow-revisions__list" aria-label={copy.caption}>
      {#each revisions.data as revision (revision.workflowVersion)}
        <li class="weft-workflow-revisions__row">
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

  .weft-workflow-revisions__description,
  .weft-workflow-revisions__none {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
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
    overflow-wrap: anywhere;
  }
</style>
