<script lang="ts" module>
  export const title = 'Upcoming and past runs';
  export const description =
    'The list variant with hollow pending rings, a Skip action on each upcoming run, the Now marker, the missed runs once as a collapsed amber band below it, and a separator where daylight saving time ended.';
</script>

<script lang="ts">
  import { Button, Timeline, formatDateTime, formatRelativeTime } from '@lostgradient/cinder';
  import type { TimelineEntry } from '@lostgradient/cinder';

  // The sample world: now is Mon Nov 2, 10:46 AM Central. Upcoming runs name their calendar day
  // (never "Tomorrow") and say how far away they are in spelled-out units.
  const now = Date.parse('2026-11-02T16:46:00Z');
  const clock = { timeZone: 'America/Chicago', now, dayWords: false } as const;
  const upcoming = (id: string, datetime: string): TimelineEntry => ({
    id,
    datetime,
    timestamp: formatDateTime(datetime, clock),
    title: formatRelativeTime(datetime, { ...clock, units: 'spelled' }),
    tone: 'pending',
  });

  const missedRuns = [
    'Mon Nov 2, 3:00 AM',
    'Sun Nov 1, 3:00 AM',
    'Sat Oct 31, 4:00 AM',
    'Fri Oct 30, 4:00 AM',
  ];

  const entries: TimelineEntry[] = [
    upcoming('nov-5', '2026-11-05T09:00:00Z'),
    upcoming('nov-4', '2026-11-04T09:00:00Z'),
    upcoming('nov-3', '2026-11-03T09:00:00Z'),
    {
      id: 'now',
      kind: 'now',
      datetime: '2026-11-02T16:46:00Z',
      timestamp: formatDateTime(now, clock),
      title: 'Now',
    },
    {
      id: 'missed',
      kind: 'band',
      tone: 'warning',
      datetime: '2026-11-02T09:00:00Z',
      timestamp: 'Mon Nov 2',
      title: 'Missed 4 times since Oct 30',
      detail: 'Interborough was off',
      expandLabel: 'Show each',
      collapseLabel: 'Hide',
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

<div style="max-width: 36rem;">
  <Timeline {entries} variant="list" label="Runs">
    {#snippet children(entry)}
      {#if entry.kind === 'band'}
        <ul>
          {#each missedRuns as run (run)}<li>{run}</li>{/each}
        </ul>
      {/if}
    {/snippet}
    {#snippet actions(entry)}
      {#if entry.tone === 'pending'}
        <Button variant="secondary" size="sm">Skip</Button>
      {/if}
    {/snippet}
  </Timeline>
</div>
