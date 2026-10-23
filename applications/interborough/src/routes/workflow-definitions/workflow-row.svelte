<script lang="ts">
  /**
   * One flat row of `/workflows`: the workflow's name (its identifier, so monospace), its kind and
   * state as badges, the agent that owns a file, what it is for, and one line of facts: what starts
   * it, how many instances ran lately (and how many are running), and when the last began. A fact
   * the Bureau or the engine did not give is left out, so a count that could not be read is never
   * shown as zero. A file the Bureau cannot use shows its error, its issues, and its path.
   */
  import { Badge, CodeLocation } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { CatalogRow, CodeActivity } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import FileProblem from './file-problem.svelte';
  import {
    rowBadges,
    rowState,
    runCountsText,
    schedulesSummary,
    triggerSummary,
  } from './workflow-presentation.ts';

  interface Props {
    row: CatalogRow;
    /** What the engine said of a code-defined type, once it has said it. */
    activity?: CodeActivity | undefined;
    /** Where the row's file is, once the host has said where the files are. */
    filePath?: string | undefined;
  }

  let { row, activity, filePath }: Props = $props();

  const copy = WORKFLOW_COPY;
  const path = $derived(workflowTypePath(row.name));
  const runs = $derived(row.kind === 'code' ? activity?.runs : row.runs);
  const counts = $derived(runs === undefined || runs === null ? null : runCountsText(runs));
  const starts = $derived(
    row.kind === 'code'
      ? schedulesSummary(activity?.schedules ?? null)
      : triggerSummary(row.trigger),
  );

  function go(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<li
  class="ib-workflow-row"
  data-workflow={row.name}
  data-kind={row.kind}
  data-state={rowState(row)}
>
  <div class="ib-workflow-row__title">
    <a class="ib-workflow-name" href={router.href(path)} onclick={go}>{row.name}</a>
    {#each rowBadges(row) as badge (badge.label)}
      <span data-testid={badge.testId}>
        <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
      </span>
    {/each}
    {#if row.agent !== null}
      <code class="ib-workflow-agent" data-testid="workflow-agent">{row.agent}</code>
    {/if}
  </div>
  {#if row.description}
    <p class="ib-workflow-row__description" data-testid="workflow-description">
      {row.description}
    </p>
  {/if}
  {#if row.problem !== null}
    <FileProblem problem={row.problem} />
  {/if}
  {#if row.file !== null && row.file.state === 'invalid' && filePath !== undefined}
    <CodeLocation file={filePath} data-testid="workflow-file-path" />
  {/if}
  {#if starts !== null || counts !== null}
    <div class="ib-workflow-row__meta">
      {#if starts !== null}
        <span data-testid="workflow-cadence">
          {#if starts.kind === 'signal'}{copy.list.onSignal}
            <code>{starts.name}</code>{:else}{starts.words}{/if}
        </span>
      {/if}
      {#if counts !== null}
        <span data-testid="workflow-run-counts">{counts.runs}</span>
        {#if counts.lastRun !== null}
          <span data-testid="workflow-last-run">{counts.lastRun}</span>
        {/if}
      {/if}
    </div>
  {/if}
</li>
