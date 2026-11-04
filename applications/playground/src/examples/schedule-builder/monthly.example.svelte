<script lang="ts" module>
  export const title = 'Monthly in another time zone';
  export const description =
    'Monthly on a day adds a Day of month field between At and Time zone. The schedule keeps its own zone (here Pacific time), and Runs reads the day, the time and the zone back.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ cron: '0 9 1 * *', timeZone: 'America/Los_Angeles' });

  // Cinder ships no date math — a real app would bring its own cron library here.
  // Labels are illustrative static strings, not computed dates.
  function computeNextFires(_current: ScheduleValue, count: number): ScheduleFire[] {
    const days = ['Tue Dec 1', 'Fri Jan 1', 'Mon Feb 1'];
    return days.slice(0, count).map((day) => ({ id: day, label: `${day}, 9:00 AM` }));
  }
</script>

<ScheduleBuilder
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  previewCount={3}
  label="Triage schedule"
/>
