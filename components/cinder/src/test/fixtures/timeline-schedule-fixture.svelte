<script lang="ts" module>
  /** Test-only fixture: upcoming runs with a Skip action, the Now marker, a separator and a past run. */
  export type TimelineScheduleFixtureProps = {
    variant?: 'rail' | 'list' | undefined;
  };
</script>

<script lang="ts">
  import Timeline from '../../components/timeline/timeline.svelte';
  import type { TimelineEntry } from '../../components/timeline/timeline.types.ts';

  let { variant = 'list' }: TimelineScheduleFixtureProps = $props();

  const entries: TimelineEntry[] = [
    {
      id: 'nov-5',
      datetime: '2026-11-05T09:00:00Z',
      timestamp: 'Thu Nov 5, 3:00 AM',
      title: 'in 3 days',
      tone: 'pending',
    },
    {
      id: 'nov-4',
      datetime: '2026-11-04T09:00:00Z',
      timestamp: 'Wed Nov 4, 3:00 AM',
      title: 'in 2 days',
      tone: 'pending',
    },
    {
      id: 'nov-3',
      datetime: '2026-11-03T09:00:00Z',
      timestamp: 'Tue Nov 3, 3:00 AM',
      title: 'in 16 hours',
      tone: 'pending',
    },
    {
      id: 'now',
      kind: 'now',
      datetime: '2026-11-02T16:46:00Z',
      timestamp: 'Mon Nov 2, 10:46 AM',
      title: 'Now',
    },
    {
      id: 'dst',
      kind: 'separator',
      datetime: '2026-11-01T06:00:00Z',
      timestamp: 'Nov 1',
      title: 'Daylight saving time ended Nov 1',
    },
    {
      id: 'oct-29',
      datetime: '2026-10-29T09:00:00Z',
      timestamp: 'Thu Oct 29, 4:00 AM',
      title: 'Done',
      tone: 'success',
    },
  ];
</script>

<Timeline {entries} {variant} label="Runs">
  {#snippet children(entry)}
    <span data-testid={`body-${entry.id}`}>body</span>
  {/snippet}
  {#snippet actions(entry)}
    <button type="button" data-testid={`skip-${entry.id}`}>Skip</button>
  {/snippet}
</Timeline>
