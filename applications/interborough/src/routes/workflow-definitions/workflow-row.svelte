<script lang="ts">
  /**
   * One row of the table on `/workflows`: the workflow's name (its identifier, so monospace) and
   * what it is for, its kind as a badge and the agent that owns a file, what starts it, how many
   * instances ran lately (and how many are running) and when the last began, and its status as one
   * of the seven words. A fact the Bureau or the engine did not give is left out, so a count that
   * could not be read is never shown as zero. A file the Bureau cannot use shows its error, its
   * issues, and its path.
   */
  import { Badge, CodeLocation, Table } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { useAgentDisplayName } from '../../lib/agent-display-name.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import type { CatalogRow, CodeActivity } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import FileProblem from './file-problem.svelte';
  import {
    rowBadges,
    rowState,
    runCountsText,
    schedulesSummary,
    triggerSummary,
    workflowRowStatus,
  } from './workflow-presentation.ts';

  interface Props {
    row: CatalogRow;
    /** What the engine said of a code-defined type, once it has said it. */
    activity?: CodeActivity | undefined;
    /** Where the row's file is, once the host has said where the files are. */
    filePath?: string | undefined;
  }

  let { row, activity, filePath }: Props = $props();

  const agentLabel = useAgentDisplayName();
  const copy = WORKFLOW_COPY;
  const path = $derived(workflowTypePath(row.name));
  const runs = $derived(row.kind === 'code' ? activity?.runs : row.runs);
  const counts = $derived(runs === undefined || runs === null ? null : runCountsText(runs));
  const starts = $derived(
    row.kind === 'code'
      ? schedulesSummary(activity?.schedules ?? null)
      : triggerSummary(row.trigger),
  );

  const status = $derived(workflowRowStatus(row, activity));

  function go(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<Table.Row
  data-workflow={row.name}
  data-kind={row.kind}
  data-state={rowState(row)}
  data-status={status ?? undefined}
>
  <Table.Cell class="ib-records__wrap">
    <a class="ib-workflow-name" href={router.href(path)} onclick={go}>{row.name}</a>
    {#if row.description}
      <p class="ib-workflow-row__description" data-testid="workflow-description">
        {row.description}
      </p>
    {/if}
    {#if row.problem !== null}
      <FileProblem problem={row.problem} />
    {/if}
    {#if row.file !== null && row.file.state === 'invalid' && filePath !== undefined}
      <CodeLocation class="weft-code-location" file={filePath} data-testid="workflow-file-path" />
    {/if}
  </Table.Cell>
  <Table.Cell class="ib-records__wrap">
    {#each rowBadges(row) as badge (badge.label)}
      <span data-testid={badge.testId}>
        <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
      </span>
    {/each}
    {#if row.agent !== null}
      <code class="ib-workflow-agent" data-testid="workflow-agent">{agentLabel(row.agent)}</code>
    {/if}
  </Table.Cell>
  <Table.Cell class="ib-records__wrap">
    {#if starts !== null}
      <span data-testid="workflow-cadence">
        {#if starts.kind === 'signal'}{copy.list.onSignal}
          <code>{starts.name}</code>{:else}{starts.words}{/if}
      </span>
    {/if}
  </Table.Cell>
  <Table.Cell class="ib-records__wrap">
    {#if counts !== null}
      <span data-testid="workflow-run-counts">{counts.runs}</span>
      {#if counts.lastRun !== null}
        <span class="ib-records__muted" data-testid="workflow-last-run">{counts.lastRun}</span>
      {/if}
    {/if}
  </Table.Cell>
  <Table.Cell>
    {#if status !== null}<StatusLabel word={status} />{/if}
  </Table.Cell>
</Table.Row>
