<script lang="ts" module>
  export const title = 'With overlap and catch-up';
  export const description =
    'Pass overlap and catchUp to draw the two policy selects below the Runs panel. The builder only draws and reports them; the page keeps their values and decides what they mean.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ cron: '0 9 * * *', timeZone: 'America/Chicago' });
  let overlap = $state('skip');
  let catchUp = $state(false);

  // Cinder ships no date math — a real app would bring its own cron library here.
  // Labels are illustrative static strings, not computed dates.
  function computeNextFires(_current: ScheduleValue, count: number): ScheduleFire[] {
    const days = ['Tue Nov 3', 'Wed Nov 4', 'Thu Nov 5', 'Fri Nov 6', 'Mon Nov 9'];
    return days.slice(0, count).map((day) => ({ id: day, label: `${day}, 9:00 AM` }));
  }
</script>

<ScheduleBuilder
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  previewCount={3}
  {overlap}
  onOverlapChange={(next) => (overlap = next)}
  {catchUp}
  onCatchUpChange={(next) => (catchUp = next)}
  catchUpLabel="If the app was off"
  label="Report schedule"
/>
