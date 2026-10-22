<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from './index.ts';

  // Cinder ships no date math, so the preview labels are illustrative static
  // strings rather than computed dates.
  function computeNextFires(current: ScheduleValue, count: number): ScheduleFire[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `fire-${index}`,
      label:
        current.mode === 'interval'
          ? `Run ${index + 1}, in ${(index + 1) * current.every} ${current.unit}`
          : `Run ${index + 1}`,
    }));
  }
</script>

<ScheduleBuilder
  {computeNextFires}
  timezoneLabel="America/New_York"
  label="Data sync schedule"
  previewCount={3}
/>
