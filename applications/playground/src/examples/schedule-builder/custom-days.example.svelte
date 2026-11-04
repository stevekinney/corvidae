<script lang="ts" module>
  export const title = 'Custom days';
  export const description =
    'Custom days shows At beside one joined seven-button group, Mon to Sun, with the chosen days (here Mon, Wed and Fri) filled in the accent tint. Runs reads the days back and lists the next runs.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ cron: '0 9 * * 1,3,5', timeZone: 'America/Chicago' });

  // Cinder ships no date math — a real app would bring its own cron library here.
  // Labels are illustrative static strings, not computed dates.
  function computeNextFires(_current: ScheduleValue, count: number): ScheduleFire[] {
    const days = ['Wed Nov 4', 'Fri Nov 6', 'Mon Nov 9'];
    return days.slice(0, count).map((day) => ({ id: day, label: `${day}, 9:00 AM` }));
  }
</script>

<ScheduleBuilder
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  previewCount={3}
  label="Inbox check schedule"
/>
