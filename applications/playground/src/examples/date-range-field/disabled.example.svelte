<script lang="ts" module>
  export const title = 'Disabled state';
  export const description =
    'All inputs and preset buttons are disabled. Use when the date range cannot be edited in the current context.';
</script>

<script lang="ts">
  import { DateRangeField, type DateRangeValue } from '@lostgradient/cinder';

  const range: DateRangeValue = { start: '2026-06-01', end: '2026-06-30' };
</script>

<DateRangeField id="disabled-date-range" label="Billing period" value={range} disabled />
