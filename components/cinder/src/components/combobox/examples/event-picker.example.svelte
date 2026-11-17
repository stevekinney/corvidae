<script lang="ts" module>
  export const title = 'Event picker with code and meta';
  export const description =
    'A raw identifier beside the name, what the event narrows by at the trailing edge, a check before the text, and the match count beside the search field.';
</script>

<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-event-picker`);

  const events = [
    {
      value: 'run.error',
      label: 'A run fails',
      code: 'run.error',
      meta: 'any workflow',
      group: 'Runs',
    },
    {
      value: 'review.requested',
      label: 'A review is requested',
      code: 'review.requested',
      meta: 'any agent',
      group: 'Reviews',
    },
    {
      value: 'goal.failed',
      label: 'A goal fails',
      code: 'goal.failed',
      meta: 'any agent',
      group: 'Goals',
    },
    {
      value: 'schedule.missed',
      label: 'A schedule misses a run',
      code: 'schedule.missed',
      meta: 'any schedule',
      group: 'Schedules',
    },
  ];
</script>

<Combobox
  id={fieldId}
  label="Event"
  presentation="picker"
  placeholder="Pick an event"
  searchPlaceholder="Search events"
  options={events}
  selectedIndicator="start"
  matchCountVisible
  value="run.error"
>
  {#snippet footer(context)}
    Showing {context.matchCount} of {context.totalCount} events.
  {/snippet}
</Combobox>
