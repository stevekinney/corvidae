<script lang="ts" module>
  export const title = 'Status-first two-line row';
  export const description =
    'Line one is a status dot and word in a fixed 128px column, a bold title and the time at the right edge; line two is muted meta that starts under the title. The whole row is one link, and an empty-status row keeps the column so titles line up.';
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
    title: string;
    status: StatusDotWordLabel;
    time: string;
    meta: string;
  };

  const runs: Run[] = [
    {
      id: 'refund-4471',
      title: 'Refund order 4471',
      status: 'Waiting on you',
      time: '10:42 AM',
      meta: 'Chat, Tool runner, waiting 4 min',
    },
    {
      id: 'say-hello',
      title: 'Say hello',
      status: 'Done',
      time: '4:12 PM',
      meta: 'Chat, Assistant, 8 s',
    },
    {
      id: 'release-notes',
      title: 'Release notes',
      status: 'Failed',
      time: '11:00 AM',
      meta: 'Schedule, Release notes digest, failed at step 2 of 4, GitHub didn’t answer (HTTP 503)',
    },
  ];

  const workflows = [
    {
      id: 'triage-inbox',
      title: 'Triage inbox',
      time: 'Oct 24',
      meta: '3 steps, 1 run, last ran Oct 24',
    },
  ];
</script>

<DataList items={runs} key={(run) => run.id} statusColumn>
  {#snippet children(run)}
    <StackedListItem href={`#${run.id}`} tooltip={run.title}>
      {#snippet status()}<StatusDot word={run.status} />{/snippet}
      {#snippet title()}{run.title}{/snippet}
      {#snippet time()}{run.time}{/snippet}
      {#snippet meta()}{run.meta}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>

<DataList items={workflows} key={(workflow) => workflow.id} statusColumn>
  {#snippet children(workflow)}
    <StackedListItem href={`#${workflow.id}`} tooltip={workflow.title}>
      {#snippet title()}{workflow.title}{/snippet}
      {#snippet time()}{workflow.time}{/snippet}
      {#snippet meta()}{workflow.meta}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
