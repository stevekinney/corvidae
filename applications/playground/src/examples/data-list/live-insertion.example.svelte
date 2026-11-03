<script lang="ts" module>
  export const title = 'A row inserted while you watch';
  export const description =
    'insertionAnnouncement makes the list live: a new run appears at the top of its group, a polite live region says "1 new run", and the page does not change size or lose its place.';
</script>

<script lang="ts">
  import {
    Button,
    DataList,
    StackedListItem,
    StatusDot,
    type StatusDotWordLabel,
  } from '@lostgradient/cinder';

  type Run = { id: string; title: string; status: StatusDotWordLabel; time: string; meta: string };

  let runs = $state<Run[]>([
    {
      id: 'refund-4471',
      title: 'Refund order 4471',
      status: 'Waiting on you',
      time: '10:42 AM',
      meta: 'Chat · Tool runner · waiting 4 min',
    },
    {
      id: 'refund-4472',
      title: 'Look up order 4472',
      status: 'Done',
      time: '10:30 AM',
      meta: 'Chat · Tool runner · 14 s',
    },
  ]);

  function startRun() {
    runs = [
      {
        id: 'lookup-4475',
        title: 'Look up order 4475',
        status: 'Running',
        time: '10:45 AM',
        meta: 'Chat · Tool runner · running 12 s',
      },
      ...runs,
    ];
  }
</script>

<Button onclick={startRun}>Start a run</Button>
<DataList
  items={runs}
  key={(run) => run.id}
  groupBy={() => ({ key: 'today', label: 'Today · Monday, Nov 2', detail: 'Central time' })}
  insertionAnnouncement={(count) => `${count} new run${count === 1 ? '' : 's'}`}
>
  {#snippet children(run)}
    <StackedListItem href={`#${run.id}`} tooltip={run.title}>
      {#snippet status()}<StatusDot word={run.status} />{/snippet}
      {#snippet title()}{run.title}{/snippet}
      {#snippet time()}{run.time}{/snippet}
      {#snippet meta()}{run.meta}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
