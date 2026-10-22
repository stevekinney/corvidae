<script lang="ts" module>
  export const title = 'Presets mode';
  export const description =
    'Presets is the default authoring mode, and offers Daily, Weekly and Monthly. Each lowers to a cron expression, so the summary line reads as a sentence and always reflects the resulting cron value, never a "preset".';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ mode: 'cron', expression: '0 9 * * *' });

  // Static, illustrative fire labels — no date library involved.
  function computeNextFires(current: ScheduleValue, count: number): ScheduleFire[] {
    const suffix =
      current.mode === 'interval' ? `every ${current.every} ${current.unit}` : current.expression;
    return Array.from({ length: count }, (_, index) => ({
      id: `fire-${index}`,
      label: `Fire ${index + 1} — ${suffix}`,
    }));
  }

  function handleChange(next: ScheduleValue): void {
    value = next;
  }
</script>

<ScheduleBuilder {value} onValueChange={handleChange} {computeNextFires} label="Backup schedule" />
