<script lang="ts" module>
  export const title = 'Basic schedule builder';
  export const description =
    'Choose how a schedule repeats, the time it runs at and its time zone. The read-back sentence and the next runs stay visible whichever choice is showing.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ cron: '0 9 * * 1-5', timeZone: 'America/Los_Angeles' });

  // Cinder ships no date math — a real app would bring its own cron library here.
  // Labels are illustrative static strings, not computed dates.
  function computeNextFires(current: ScheduleValue, count: number): ScheduleFire[] {
    const cadence =
      'every' in current ? `every ${current.every.count} ${current.every.unit}` : current.cron;
    return Array.from({ length: count }, (_, index) => ({
      id: `fire-${index}`,
      label: `Fire ${index + 1} — ${cadence}`,
    }));
  }

  function handleChange(next: ScheduleValue): void {
    value = next;
  }
</script>

<ScheduleBuilder
  {value}
  onValueChange={handleChange}
  {computeNextFires}
  label="Data sync schedule"
/>
