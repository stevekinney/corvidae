<script lang="ts" module>
  /** Test-only fixture: the Now marker, a collapsed amber band of missed runs, and a past run. */
  export type TimelineBandFixtureProps = {
    tone?: 'warning' | 'info' | undefined;
  };
</script>

<script lang="ts">
  import Timeline from '../../components/timeline/timeline.svelte';
  import type { TimelineEntry } from '../../components/timeline/timeline.types.ts';

  let { tone = 'warning' }: TimelineBandFixtureProps = $props();

  const entries: TimelineEntry[] = $derived([
    {
      id: 'now',
      kind: 'now',
      datetime: '2026-11-02T16:46:00Z',
      timestamp: 'Mon Nov 2, 10:46 AM',
      title: 'Now',
    },
    {
      id: 'missed',
      kind: 'band',
      tone,
      datetime: '2026-11-02T09:00:00Z',
      timestamp: 'Mon Nov 2',
      title: 'Missed 4 times since Oct 30',
      detail: 'Interborough was off',
      expandLabel: 'Show each',
    },
    {
      id: 'oct-29',
      datetime: '2026-10-29T09:00:00Z',
      timestamp: 'Thu Oct 29, 4:00 AM',
      title: 'Done',
      tone: 'success',
    },
  ]);
</script>

<Timeline {entries} variant="list" label="Runs">
  {#snippet children(entry)}
    {#if entry.kind === 'band'}
      <span data-testid="missed-detail">Mon Nov 2, 3:00 AM</span>
    {/if}
  {/snippet}
</Timeline>
