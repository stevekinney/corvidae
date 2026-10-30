<script lang="ts" module>
  export const title = 'Custom cron';
  export const description =
    'Custom cron is the escape hatch for a schedule no other choice produces. Each of the five fields has a structured editor with an inline error, and an invalid expression is never emitted.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  // A step restarts at midnight, so it opens as Custom cron rather than as an interval.
  let value = $state<ScheduleValue>({ cron: '0 */6 * * *', timeZone: 'UTC' });

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
  label="Report job schedule"
/>
