<script lang="ts">
  /**
   * The Runs tab: the newest runs of one workflow, newest first, each a link to the run with its
   * status, how long ago it began, and how long it took once it has ended; and a link to all of
   * them. A workflow that has not run is an empty state that offers to start one where it can. A file's
   * runs are the Bureau's (`bureau.workflows.runs.list`) and a code type's the engine's, because
   * the two services each know only their own instances.
   */
  import { Alert, Button, EmptyState, SectionHeading, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { formatDuration, formatRelativeTime } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, workflowRunPath } from '../../lib/router.svelte.ts';
  import { listWorkflowFileRuns } from '../../lib/workflow-files.ts';
  import { workflowRunsPath } from '../../lib/workflow-type-paths.ts';
  import { workflowStatusBadge } from '../workflows/list/workflow-status-badge.ts';
  import WorkflowStatusIcon from '../workflows/list/workflow-status-icon.svelte';

  interface Props {
    /** The workflow's type, which is its file's identifier for an agent-authored workflow. */
    type: string;
    /** Whose runs: the Bureau's for a file, the engine's for a code-defined type. */
    kind: 'code' | 'agent-authored';
    /** Starts a run, when this workflow can be started from the page; the empty state offers it. */
    onStart?: (() => void) | undefined;
    /** Resumes a paused file, when this page can; the empty state of a paused file offers it. */
    onResume?: (() => void) | undefined;
  }

  let { type, kind, onStart, onResume }: Props = $props();

  const copy = WORKFLOW_COPY;
  const client = getClient();
  /** How many runs the page shows before it links to the rest. */
  const RECENT_LIMIT = 20;

  type Run = {
    readonly id: string;
    readonly status: Parameters<typeof workflowStatusBadge>[0];
    readonly createdAt: number;
    readonly updatedAt: number;
  };

  const runs = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.recentRuns(kind, type),
      queryFn: async ({ signal }): Promise<readonly Run[]> => {
        if (kind === 'agent-authored') {
          const files = await listWorkflowFileRuns(type, RECENT_LIMIT, { signal });
          return files.map((run) => ({
            id: run.id,
            status: run.status,
            createdAt: Date.parse(run.createdAt),
            updatedAt: Date.parse(run.updatedAt),
          }));
        }
        const page = await client.list({ type, limit: RECENT_LIMIT });
        return page.items.map((run) => ({
          id: run.id,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        }));
      },
      retry: false,
    }),
    undefined,
  );

  const runsPath = $derived(workflowRunsPath(type));

  /** A run that has ended took as long as its last update says; one still going has no duration yet. */
  function durationOf(run: Run): string | undefined {
    const ended = !['pending', 'running', 'suspended'].includes(run.status);
    return ended ? formatDuration(Math.max(0, run.updatedAt - run.createdAt)) : undefined;
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-workflow__section" data-testid="workflow-recent-runs">
  <SectionHeading level={2} title={copy.page.recentRuns}>
    {#snippet actions()}
      <a href={router.href(runsPath)} onclick={(event) => go(event, runsPath)}>{copy.runsAction}</a>
    {/snippet}
  </SectionHeading>
  {#if runs.isError}
    <Alert variant="danger">
      <p class="ib-workflow__alert-body">{copy.page.runsFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void runs.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if runs.isPending}
    <div role="status" aria-busy="true" aria-label={copy.page.recentRuns}>
      <Skeleton height="1.5rem" />
    </div>
  {:else if runs.data.length === 0 && onStart !== undefined}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.page.runs.emptyTitle}
      description={copy.page.runs.emptyDescription}
    >
      {#snippet action()}
        <Button variant="primary" size="sm" onclick={onStart}>{copy.page.startAction}</Button>
      {/snippet}
    </EmptyState>
  {:else if runs.data.length === 0 && kind === 'agent-authored' && onResume !== undefined}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.page.runs.emptyTitle}
      description={copy.page.runs.emptyDescriptionPaused}
    >
      {#snippet action()}
        <Button data-changes variant="primary" size="sm" onclick={onResume}
          >{copy.resumeAction}</Button
        >
      {/snippet}
    </EmptyState>
  {:else if runs.data.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.page.runs.emptyTitle}
      description={kind === 'agent-authored'
        ? copy.page.runs.emptyDescriptionPaused
        : copy.page.runs.emptyDescriptionCode}
    />
  {:else}
    <ul class="ib-workflow__list">
      {#each runs.data as run (run.id)}
        {@const status = workflowStatusBadge(run.status)}
        {@const took = durationOf(run)}
        <li data-run={run.id} data-status={run.status}>
          <a
            class="ib-workflow__run-status"
            href={router.href(workflowRunPath(type, run.id))}
            onclick={(event) => go(event, workflowRunPath(type, run.id))}
          >
            <WorkflowStatusIcon icon={status.icon} />
            {status.label}
          </a>
          <span>{formatRelativeTime(run.createdAt)}</span>
          {#if took !== undefined}<span class="ib-workflow__muted"
              >{copy.page.runDuration(took)}</span
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
