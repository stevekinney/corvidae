<script lang="ts" module>
  export const title = 'Compact';
  export const description =
    'The compact variant fits a form that already says what runs: Repeats, At and Time zone share one row, the policy selects follow, and Next runs is a plain list with no sentence and no panel.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ cron: '0 9 * * 1-5', timeZone: 'America/Chicago' });
  let overlap = $state('skip');
  let catchUp = $state(false);

  // Cinder ships no date math — a real app would bring its own cron library here.
  // Labels are illustrative static strings, not computed dates.
  function computeNextFires(_current: ScheduleValue, count: number): ScheduleFire[] {
    const days = ['Tue Nov 3', 'Wed Nov 4', 'Thu Nov 5', 'Fri Nov 6', 'Mon Nov 9'];
    return days.slice(0, count).map((day) => ({ id: day, label: `${day}, 9:00 AM CST` }));
  }
</script>

<ScheduleBuilder
  variant="compact"
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  previewCount={3}
  {overlap}
  onOverlapChange={(next) => (overlap = next)}
  {catchUp}
  onCatchUpChange={(next) => (catchUp = next)}
  label="Workflow schedule"
/>
