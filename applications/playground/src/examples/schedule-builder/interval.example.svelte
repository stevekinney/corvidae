<script lang="ts" module>
  export const title = 'Every few minutes or hours';
  export const description =
    'An interval counts from the start of the schedule, so an uneven one such as every 7 hours is exact. It emits an every value rather than a cron, and At is hidden.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({
    every: { unit: 'hours', count: 7 },
    timeZone: 'UTC',
  });

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
  label="Health check schedule"
/>
