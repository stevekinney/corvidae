<script lang="ts" module>
  /**
   * How long a load is let to finish before anything is drawn for it, which is Cinder's loading
   * rule: a read that is quick never flashes a placeholder.
   */
  export const LIST_LOADING_DELAY_MILLISECONDS = 300;

  /** How long a load runs before the placeholders say it is taking longer than usual. */
  export const LIST_STILL_LOADING_MILLISECONDS = 10_000;
</script>

<script lang="ts">
  /**
   * The Schedules list while the schedules are being read (row 70s): the filter bar with its
   * segments and chips as they will read, the segments without counts and the Missed runs chip
   * without one, then four placeholder rows in the real row layout (a status dot, title and meta
   * bars and a next-run bar). Nothing of it is drawn for the first 300 ms, so a quick read never
   * flashes a placeholder; the page's header is real throughout and is not part of this. After 10 s
   * a "Still loading" line says it is taking longer than usual.
   */
  import {
    FilterBar,
    Skeleton,
    type AppliedFilter,
    type FacetDefinition,
    type FilterSegment,
  } from '@lostgradient/cinder';

  import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';

  interface Props {
    /** The segments, without counts: each is drawn with a placeholder where its count will be. */
    segments: readonly FilterSegment[];
    /** The chosen segment, as the address says. */
    segmentValue: string;
    /** The chips; the Missed runs chip carries no count until the schedules are read. */
    facets: readonly FacetDefinition[];
    /** The filters the address already applies. */
    appliedFilters: readonly AppliedFilter[];
    /** Called when a segment is chosen, so the filters can be changed before the list arrives. */
    onSegmentChange: (value: string) => void;
    /** Called when a chip's value changes. */
    onFacetChange: (key: string, value: string) => void;
    /** Called when an applied chip is removed. */
    onFilterRemove: (key: string) => void;
  }

  let {
    segments,
    segmentValue,
    facets,
    appliedFilters,
    onSegmentChange,
    onFacetChange,
    onFilterRemove,
  }: Props = $props();

  // The skeleton keeps its own time, so the filter bar waits the same delay beside it.
  let revealed = $state(false);
  $effect(() => {
    // poll-reason: timer
    const timer = setTimeout(() => {
      revealed = true;
    }, LIST_LOADING_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  });

  const placeholders = $derived(
    segments.map((segment): FilterSegment => ({ ...segment, count: 'pending' })),
  );
  const chips = $derived(
    facets.map((facet): FacetDefinition => {
      if (facet.type !== 'toggle') return facet;
      const { count: _count, ...withoutCount } = facet;
      return withoutCount;
    }),
  );
</script>

{#if revealed}
  <FilterBar
    aria-label={SCHEDULE_COPY.filtersLabel}
    searchVisible={false}
    segments={placeholders}
    {segmentValue}
    facets={chips}
    {appliedFilters}
    {onSegmentChange}
    {onFacetChange}
    {onFilterRemove}
  />
{/if}
<Skeleton
  variant="list"
  rows={4}
  statusMarker="dot"
  delay={LIST_LOADING_DELAY_MILLISECONDS}
  stillLoadingAfter={LIST_STILL_LOADING_MILLISECONDS}
  stillLoadingLabel={SCHEDULE_COPY.stillLoading}
  label={SCHEDULE_COPY.loading}
/>
