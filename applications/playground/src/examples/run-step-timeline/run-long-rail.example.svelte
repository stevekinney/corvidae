<script lang="ts" module>
  export const title = 'What happened: a long rail, collapsed';
  export const description =
    'A rail of eight or more entries shows the first three and the last three, with one row between reading "3 more calls" and a "Show all 9" action. Show all opens the middle in place. Failed and waiting entries are never collapsed.';
</script>

<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '9:35:00 AM',
      description: 'You sent a message in the chat',
    },
    {
      id: 'lookup-4455',
      label: 'Looked up order 4455',
      status: 'succeeded',
      time: '+2 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'lookup-4456',
      label: 'Looked up order 4456',
      status: 'succeeded',
      time: '+4 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'lookup-4457',
      label: 'Looked up order 4457',
      status: 'succeeded',
      time: '+6 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'lookup-4458',
      label: 'Looked up order 4458',
      status: 'succeeded',
      time: '+8 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'lookup-4459',
      label: 'Looked up order 4459',
      status: 'succeeded',
      time: '+10 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'triaged',
      label: 'Triaged 3 refunds',
      status: 'succeeded',
      time: '+37 s',
      description: 'Used Triage refunds `triage-refunds`',
    },
    {
      id: 'replied',
      label: 'Replied',
      status: 'succeeded',
      time: '+40 s',
      description: 'Reply delivered to the chat',
    },
    {
      id: 'done',
      label: 'Done',
      status: 'succeeded',
      time: '+41 s',
      description: 'Finished without errors',
    },
  ];
</script>

<RunStepTimeline
  {steps}
  variant="narrative"
  label="What happened: triage refunds"
  fold={{ label: (hidden) => `${hidden} more calls` }}
/>
