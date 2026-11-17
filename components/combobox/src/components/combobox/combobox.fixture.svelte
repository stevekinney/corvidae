<script lang="ts">
  import Combobox from './combobox.svelte';

  const options = [
    {
      value: 'run.error',
      label: 'A run fails',
      code: 'run.error',
      meta: 'any workflow',
      group: 'Runs',
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
      group: 'Schedules',
    },
  ];
  let { presentation = 'input' }: { presentation?: 'input' | 'picker' } = $props();
</script>

<Combobox
  id="event"
  label="Event"
  {presentation}
  searchPlaceholder="Search events"
  matchCountVisible
  {options}
>
  {#snippet footer(context)}
    <span
      >Showing {context.matchCount} of {context.totalCount} events.
      <a href="#clear">Clear the search</a></span
    >
  {/snippet}
</Combobox>
