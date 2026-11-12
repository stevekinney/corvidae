<script lang="ts">
  /**
   * The versions of an agent-authored workflow that have run, most recently run first
   * (`bureau.workflows.revisions`). It is the Bureau's list and not the engine's: a version that
   * was saved and never ran is not on it, and nothing here activates a version, because the file
   * is what runs next. Each version is named, says whether it is the current one, and carries
   * Weft's verdict on whether it is compatible with the current one (a neutral dot and the word,
   * because amber is for what waits on you) and the reasons when it is breaking. A footnote under
   * the list says what compatibility means.
   */
  import { Alert, Button, CopyButton, EmptyState, Skeleton, StatusDot } from '@lostgradient/cinder';
  import { Copy } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { dayAndTime } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { CATALOG_STALE_TIME_MS } from '../../lib/workflow-catalog.ts';
  import { listWorkflowRevisions } from '../../lib/workflow-files.ts';

  interface Props {
    /** The workflow's identifier, which is its file's. */
    id: string;
    /** The version the file is at now, or `null` when the Bureau does not say. */
    currentVersion: string | null;
  }

  let { id, currentVersion }: Props = $props();

  const copy = WORKFLOW_COPY.revisions;

  /** The hash a person can tell versions apart by: a `sha256:` prefix is dropped and the rest cut short. */
  function shortVersionOf(version: string): string {
    const bare = version.replace(/^sha256:/, '');
    return bare.length > 12 ? bare.slice(0, 8) : bare;
  }

  const revisions = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.revisions(id),
      queryFn: ({ signal }) => listWorkflowRevisions(id, { signal }),
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
      size="compact"
      headingLevel={3}
      title={copy.emptyTitle}
      description={copy.emptyDescription}
    />
  {:else}
    <ul class="weft-workflow-revisions__list" aria-label={copy.caption}>
      {#each revisions.data as revision (revision.workflowVersion)}
        {@const shortVersion = shortVersionOf(revision.workflowVersion)}
        <li class="weft-workflow-revisions__row" data-version={revision.workflowVersion}>
          <p class="weft-workflow-revisions__version" data-testid="workflow-revision-title">
            <span title={revision.workflowVersion}
              >{copy.versionTitle(
                dayAndTime(Date.parse(revision.firstRunAt), Date.now()),
                shortVersion,
                revision.workflowVersion === currentVersion,
              )}</span
            >
            <CopyButton
              value={revision.workflowVersion}
              iconOnly
              label={copy.copyVersion(shortVersion)}
            >
              <Copy aria-hidden="true" size={13} />
            </CopyButton>
          </p>
          <p class="weft-workflow-revisions__line" data-testid="workflow-revision-verdict">
            {#if revision.compatibility === null}
              <StatusDot status="neutral" label={copy.noCurrent} />
            {:else if revision.compatibility.compatible}
              <StatusDot status="neutral" label={copy.compatible} />
            {:else}
              <StatusDot status="neutral" label={copy.incompatible} />
            {/if}{', '}<time datetime={revision.lastRunAt}
              >{copy.lastRun(dayAndTime(Date.parse(revision.lastRunAt), Date.now()))}</time
            >
          </p>
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

  .weft-workflow-revisions__reasons {
    margin: 0;
    padding-inline-start: var(--cinder-space-5);
    color: var(--cinder-text-secondary);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-workflow-revisions__footnote {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
