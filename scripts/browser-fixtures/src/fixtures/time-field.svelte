<script lang="ts">
  import { TimeField } from '@lostgradient/cinder';

  let time = $state('09:30');
  let timezone = $state<string | undefined>('America/Denver');
</script>

<TimeField
  id="time-field"
  label="Reminder time"
  bind:value={time}
  bind:timezone
  timezones={['America/Denver', 'UTC']}
  description="Stored as a canonical 24-hour time string."
/>

<p class="note text-muted">
  Value: {time}
  {timezone}
</p>

<style>
  .note {
    margin-block: 0;
  }
</style>
