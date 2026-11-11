<script lang="ts">
  /**
   * One row of the list on `/workflows`: Cinder's status-first two-line row. Line one is the status
   * word (only Paused and Can't load have one), the title with its identifier small and monospaced
   * beside it once, and at the right edge when the workflow last ran ("Never run" when it has not).
   * Line two carries the outcome and the counts: the file and its problem for a workflow that
   * cannot load, else the run in progress, the steps, and how many runs began lately. A file with no
   * title shows its identifier alone, bold and monospaced. The whole row is the link to the
   * workflow's page, so it carries no actions. A fact the Bureau or the engine did not give is left
   * out, so a count that could not be read is never shown as zero.
   */
  import { StackedListItem, StatusDot } from '@lostgradient/cinder';

  import { router } from '../../lib/router.svelte.ts';
  import type { CatalogRow } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import type { WorkflowListRow } from './workflow-presentation.ts';

  interface Props {
    /** The catalog row the model was made from. */
    row: CatalogRow;
    /** What the row says, from `workflowListRow`. */
    model: WorkflowListRow;
  }

  let { row, model }: Props = $props();

  const rowState = $derived(
    row.file?.state === 'invalid' ? 'invalid' : row.failure === null ? 'ready' : 'failed',
  );
</script>

{#snippet statusSlot()}
  {#if model.statusWord !== null}<StatusDot word={model.statusWord} size="sm" />{/if}
{/snippet}

<StackedListItem
  {...model.statusWord === null ? {} : { status: statusSlot }}
  href={router.href(workflowTypePath(row.name))}
  tooltip={model.title ?? model.name}
  data-workflow={row.name}
  data-kind={row.kind}
  data-state={rowState}
  data-status={model.statusWord ?? undefined}
>
  {#snippet title()}
    {#if model.title === null}
      <code class="ib-workflow-row__id">{model.name}</code>
    {:else}
      {model.title}
      <code class="ib-identifier" data-testid="workflow-identifier">{model.name}</code>
    {/if}
  {/snippet}
  {#snippet time()}
    {#if model.date !== null}<span data-testid="workflow-last-run">{model.date}</span>{/if}
  {/snippet}
  {#snippet meta()}
    {#each model.line as part, index (index)}
      {#if index > 0}{', '}{/if}
      <span class="ib-workflow-line__part" data-testid={part.testId}>
        {#if part.status !== undefined}<StatusDot
            word={part.status}
            size="sm"
          />{:else}{part.text}{/if}
      </span>
    {/each}
  {/snippet}
</StackedListItem>
