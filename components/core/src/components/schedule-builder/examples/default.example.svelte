<script lang="ts" module>
  export const title = 'Default schedule';
  export const description =
    'With no value, the builder opens on every day at 9:00 AM in the time zone of the browser.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  // Leave `value` unset: the builder opens on every day at 9:00 AM in the browser zone.
  let value = $state<ScheduleValue>();

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

<ScheduleBuilder {value} onValueChange={handleChange} {computeNextFires} label="Backup schedule" />
