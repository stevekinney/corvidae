<script lang="ts" module>
  /**
   * How long a load is let to finish before anything is drawn for it, which is Cinder's loading
   * rule: a read that is quick never flashes a placeholder.
   */
  export const GOAL_LOADING_DELAY_MILLISECONDS = 300;

  /** How long a load runs before the placeholders say it is taking longer than usual. */
  export const GOAL_STILL_LOADING_MILLISECONDS = 10_000;

  /** The segments of an attempts bar the placeholder draws, as many as a goal usually allows. */
  const PLACEHOLDER_SEGMENTS = 5;
</script>

<script lang="ts">
  /**
   * The Goals list while the goals are being read (design row 68k): the filter bar with its
   * segments and the Agent chip as they will read, the segments without counts, then three
   * placeholder rows in the real row layout (a status dot, a title bar and the time, and under
   * them the agent, the attempts bar and the check). Nothing of it is drawn for the first 300 ms,
   * so a quick read never flashes a placeholder; the page's header is real throughout and is not
   * part of this. After 10 s Cinder's own "Still loading goals…" line says the read is slow, with a
   * ghost Cancel (row 68l).
   */
  import {
    FilterBar,
    Skeleton,
    type AppliedFilter,
    type FacetDefinition,
    type FilterSegment,
  } from '@lostgradient/cinder';

  import { GOALS_COPY } from '../../app/copy.ts';

  interface Props {
    /** The segments, without counts: each is drawn with a placeholder where its count will be. */
    segments: readonly FilterSegment[];
    /** The chosen segment, as the address says. */
    segmentValue: string;
    /** The chips. */
    facets: readonly FacetDefinition[];
    /** The filters the address already applies. */
    appliedFilters: readonly AppliedFilter[];
    /** Called when a segment is chosen, so the filters can be changed before the list arrives. */
    onSegmentChange: (value: string) => void;
    /** Called when a chip's value changes. */
    onFacetChange: (key: string, value: string) => void;
    /** Called when an applied chip is removed. */
    onFilterRemove: (key: string) => void;
    /** Called when the person cancels a read that is taking long. */
    onCancel: () => void;
  }

  let {
    segments,
    segmentValue,
    facets,
    appliedFilters,
    onSegmentChange,
    onFacetChange,
    onFilterRemove,
    onCancel,
  }: Props = $props();

  // The skeleton keeps its own time, so the filter bar waits the same delay beside it.
  let revealed = $state(false);
  $effect(() => {
    // poll-reason: timer
    const timer = setTimeout(() => {
      revealed = true;
    }, GOAL_LOADING_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  });

  const placeholders = $derived(
    segments.map((segment): FilterSegment => ({ ...segment, count: 'pending' })),
  );
</script>

{#if revealed}
  <FilterBar
    aria-label={GOALS_COPY.filtersLabel}
    searchVisible={false}
    segments={placeholders}
    {segmentValue}
    {facets}
    {appliedFilters}
    {onSegmentChange}
    {onFacetChange}
    {onFilterRemove}
  />
{/if}
<Skeleton
  label={GOALS_COPY.loading}
  delay={GOAL_LOADING_DELAY_MILLISECONDS}
  stillLoadingAfter={GOAL_STILL_LOADING_MILLISECONDS}
  stillLoadingLabel={GOALS_COPY.stillLoading}
  {onCancel}
>
  <div class="ib-goal-loading" data-testid="goal-list-loading">
    <div class="ib-goal-loading__band">
      <Skeleton width="9rem" height="0.625rem" />
      <Skeleton width="4.5rem" height="0.5rem" />
    </div>
    {#each { length: 3 } as _, index (index)}
      <div class="ib-goal-loading__row" data-testid="goal-loading-row">
        <div class="ib-goal-loading__status">
          <Skeleton width="0.5rem" height="0.5rem" radius="var(--cinder-radius-full)" />
          <Skeleton width="3rem" height="0.625rem" />
        </div>
        <div class="ib-goal-loading__text">
          <Skeleton width="min(16rem, 60%)" height="0.625rem" />
          <div class="ib-goal-loading__meta">
            <Skeleton width="4.5rem" height="0.5rem" />
            <div class="ib-goal-loading__bar" data-testid="goal-loading-attempts">
              {#each { length: PLACEHOLDER_SEGMENTS } as _segment, segment (segment)}
                <Skeleton width="0.75rem" height="0.375rem" />
              {/each}
            </div>
            <Skeleton width="min(16rem, 40%)" height="0.5rem" />
          </div>
        </div>
        <Skeleton width="2.75rem" height="0.625rem" />
      </div>
    {/each}
  </div>
</Skeleton>

<style>
  .ib-goal-loading {
    overflow: hidden;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface);
  }

  .ib-goal-loading__band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-block: var(--cinder-space-2);
    padding-inline: var(--cinder-space-3-5);
    background: color-mix(in oklch, var(--cinder-surface), var(--cinder-surface-inset) 40%);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .ib-goal-loading__row {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) auto;
    align-items: start;
    column-gap: var(--cinder-space-3);
    padding-block: var(--cinder-space-2-5);
    padding-inline: var(--cinder-space-3-5);
  }

  .ib-goal-loading__row + .ib-goal-loading__row {
    border-block-start: 1px solid var(--cinder-border-muted);
  }

  .ib-goal-loading__status {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    padding-block-start: var(--cinder-space-1);
  }

  .ib-goal-loading__text {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    padding-block-start: var(--cinder-space-1);
    min-inline-size: 0;
  }

  .ib-goal-loading__meta {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .ib-goal-loading__bar {
    display: flex;
    gap: var(--cinder-space-1);
  }

  .ib-goal-loading__row > :global(:last-child) {
    margin-block-start: var(--cinder-space-1);
  }
</style>
