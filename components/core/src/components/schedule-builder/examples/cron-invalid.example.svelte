<script lang="ts" module>
  export const title = 'Invalid cron';
  export const description =
    'An expression that does not parse turns the field that needs fixing red and names it in one message beside an alert glyph. The Runs panel keeps one muted line, "No preview until the cron expression is valid.", with no Next runs list and no banner.';
</script>

<script lang="ts">
  import { ScheduleBuilder, type ScheduleFire, type ScheduleValue } from '@lostgradient/cinder';

  // Day of week 8 is out of range, so the builder reopens on Custom cron with that field invalid.
  let value = $state<ScheduleValue>({ cron: '0 9 * * 8', timeZone: 'UTC' });

  function computeNextFires(_current: ScheduleValue, _count: number): ScheduleFire[] {
    return [];
  }
</script>

<ScheduleBuilder
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  label="Report job schedule"
/>
