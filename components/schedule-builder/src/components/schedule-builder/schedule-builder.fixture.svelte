<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from './index.ts';

  // A fixed zone keeps the read-back the same on every machine that renders the fixture.
  const value: ScheduleValue = { cron: '0 9 * * 1-5', timeZone: 'America/New_York' };

  // Cinder ships no date math, so the preview labels are illustrative static
  // strings rather than computed dates.
  function computeNextFires(current: ScheduleValue, count: number): ScheduleFire[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `fire-${index}`,
      label:
        'every' in current
          ? `Run ${index + 1}, in ${(index + 1) * current.every.count} ${current.every.unit}`
          : `Run ${index + 1}`,
    }));
  }
</script>

<ScheduleBuilder
  {value}
  {computeNextFires}
  timeZones={['America/New_York', 'America/Los_Angeles', 'Europe/London', 'UTC']}
  label="Data sync schedule"
  previewCount={3}
/>
