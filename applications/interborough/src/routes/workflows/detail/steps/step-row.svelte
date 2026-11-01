<script lang="ts">
  /**
   * One step in the list: what it is called in words and in code, how long it took, and a waterfall
   * bar that shows where in the run it ran. The bar sits on a track as wide as the run, so the
   * rows read as one chart. A step with no start time kept has a track and no bar.
   */
  import { SelectableRow, StatusDot, type ListDetailRowContext } from '@lostgradient/cinder';
  import type { WorkflowTimelineEntry } from '@lostgradient/weft';

  import { RUN_STEPS_COPY } from '../../../../app/copy.ts';
  import { formatDuration } from '../../../../lib/format/index.ts';
  import { stepName, stepStatus } from './step-presentation.ts';
  import type { WaterfallBar } from './step-waterfall.ts';

  interface StepRowProps {
    readonly entry: WorkflowTimelineEntry;
    readonly bar: WaterfallBar | undefined;
    /** Whether the run is still in this step; false for a `running` entry it has left. */
    readonly open: boolean;
    readonly row: ListDetailRowContext;
  }

  let { entry, bar, open, row }: StepRowProps = $props();

  const name = $derived(stepName(entry));
  const status = $derived(stepStatus(entry.status, open));
  const duration = $derived(
    bar?.open === true
      ? RUN_STEPS_COPY.runningDuration
      : entry.duration === undefined
        ? undefined
        : formatDuration(entry.duration),
  );
  const barLabel = $derived(
    bar === undefined
      ? RUN_STEPS_COPY.noStart
      : RUN_STEPS_COPY.waterfallLabel(
          formatDuration(bar.startedAfter),
          entry.duration === undefined ? undefined : formatDuration(entry.duration),
        ),
  );
</script>

<SelectableRow
  selected={row.selected}
  selectedState="current"
  density="condensed"
  onclick={row.open}
  data-step-row={entry.step}
>
  {#snippet leading()}
    <StatusDot status={status.dot} label={status.label} live={false} />
  {/snippet}
  {#snippet title()}
    <span class="ib-step-row__name">{name.readable}</span>
  {/snippet}
  {#snippet description()}
    {#if name.raw !== undefined}
      <span class="ib-step-row__raw">{name.raw}</span>
    {/if}
    <span class="ib-step-row__track" role="img" aria-label={barLabel} data-waterfall>
      {#if bar !== undefined}
        <span
          class="ib-step-row__bar"
          data-status={entry.status === 'running' && !open ? 'ended' : entry.status}
          data-open={bar.open ? '' : undefined}
          data-instant={bar.instant ? '' : undefined}
          style={`inset-inline-start: ${bar.offset}%; inline-size: ${bar.width}%`}
        ></span>
      {/if}
    </span>
  {/snippet}
  {#snippet meta()}
    {#if duration !== undefined}
      <span class="ib-step-row__duration">{duration}</span>
    {/if}
  {/snippet}
</SelectableRow>

<style>
  .ib-step-row__name,
  .ib-step-row__raw {
    display: block;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ib-step-row__raw {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .ib-step-row__track {
    position: relative;
    display: block;
    inline-size: 100%;
    block-size: var(--cinder-space-2);
    margin-block-start: var(--cinder-space-1);
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-surface-inset);
    overflow: hidden;
  }

  .ib-step-row__bar {
    position: absolute;
    inset-block: 0;
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-status-success-solid);
  }

  .ib-step-row__bar[data-status='failed'],
  .ib-step-row__bar[data-status='timed-out'] {
    background: var(--cinder-status-danger-solid);
  }

  .ib-step-row__bar[data-status='running'] {
    background: var(--cinder-accent-solid);
  }

  .ib-step-row__bar[data-status='cancelled'],
  .ib-step-row__bar[data-status='ended'] {
    background: var(--cinder-text-disabled);
  }

  /* A step still going has no end, so its bar fades out at the edge where it would end. */
  .ib-step-row__bar[data-open] {
    background: linear-gradient(to right, var(--cinder-accent-solid), transparent);
  }

  .ib-step-row__duration {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
    white-space: nowrap;
  }
</style>
