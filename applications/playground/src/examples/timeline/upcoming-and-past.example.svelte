<script lang="ts" module>
  export const title = 'Upcoming and past runs';
  export const description =
    'The list variant with hollow pending rings, a Skip action on each upcoming run, the Now marker, and a separator where daylight saving time ended.';
</script>

<script lang="ts">
  import { Button, Timeline } from '@lostgradient/cinder';
  import type { TimelineEntry } from '@lostgradient/cinder';

  const entries: TimelineEntry[] = [
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

<div style="max-width: 36rem;">
  <Timeline {entries} variant="list" label="Runs">
    {#snippet actions(entry)}
      {#if entry.tone === 'pending'}
        <Button variant="secondary" size="sm">Skip</Button>
      {/if}
    {/snippet}
  </Timeline>
</div>
