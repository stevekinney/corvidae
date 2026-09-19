<script lang="ts">
  import { TimeField } from '@corvidae/cinder';

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

<p style="margin-block: 0; color: var(--cinder-text-muted);">
  Value: {time}
  {timezone}
</p>
