<script lang="ts" module>
  export const title = 'Day groups with a shared status column';
  export const description =
    'groupBy puts consecutive rows under a header band that names a nested list, and statusColumn keeps the status column for rows with nothing to report so titles line up.';
</script>

<script lang="ts">
  import {
    DataList,
    StackedListItem,
    StatusDot,
    type StatusDotWordLabel,
  } from '@lostgradient/cinder';

  type Run = {
    id: string;
    day: string;
    dayLabel: string;
    title: string;
    status?: StatusDotWordLabel;
    time: string;
    meta: string;
  };

  const runs: Run[] = [
    {
      id: 'a',
      day: 'today',
      dayLabel: 'Today · Monday, Nov 2',
      title: 'Refund order 4471',
      status: 'Waiting on you',
      time: '10:42 AM',
      meta: 'Chat · Tool runner · waiting 4 min',
    },
    {
      id: 'b',
      day: 'today',
      dayLabel: 'Today · Monday, Nov 2',
      title: 'Schedule tick',
      time: '9:00 AM',
      meta: 'Internal · Interborough started',
    },
    {
      id: 'c',
      day: 'yesterday',
      dayLabel: 'Yesterday · Sunday, Nov 1',
      title: 'Say hello',
      status: 'Done',
      time: '4:12 PM',
      meta: 'Chat · Assistant · 8 s',
    },
  ];
</script>

<DataList
  items={runs}
  key={(run) => run.id}
  statusColumn
  groupBy={(run) => ({ key: run.day, label: run.dayLabel, detail: 'Central time' })}
>
  {#snippet children(run)}
    {#if run.status}
      {@const word = run.status}
      <StackedListItem href={`#${run.id}`} tooltip={run.title}>
        {#snippet status()}<StatusDot {word} />{/snippet}
        {#snippet title()}{run.title}{/snippet}
        {#snippet time()}{run.time}{/snippet}
        {#snippet meta()}{run.meta}{/snippet}
      </StackedListItem>
    {:else}
      <StackedListItem href={`#${run.id}`} tooltip={run.title}>
        {#snippet title()}{run.title}{/snippet}
        {#snippet time()}{run.time}{/snippet}
        {#snippet meta()}{run.meta}{/snippet}
      </StackedListItem>
    {/if}
  {/snippet}
</DataList>
