<script lang="ts">
  import Combobox from './combobox.svelte';

  /** An option whose raw identifier is longer than a 320-pixel panel is wide (62 characters). */
  const longCodeOption = {
    value: 'reports:weekly-digest-ready-for-every-workspace-member-to-read',
    label: 'Weekly digest ready',
    code: 'reports:weekly-digest-ready-for-every-workspace-member-to-read',
    group: 'Weekly reports',
  };
  let {
    presentation = 'input',
    longCode = false,
  }: { presentation?: 'input' | 'picker'; longCode?: boolean } = $props();
  const options = $derived([
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
    ...(longCode ? [longCodeOption] : []),
  ]);
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
