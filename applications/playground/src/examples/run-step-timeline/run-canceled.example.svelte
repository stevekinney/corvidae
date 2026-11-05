<script lang="ts" module>
  export const title = 'What happened: a canceled run';
  export const description =
    'A canceled run lists what it did. "Drafting the summary" was interrupted, so it is a neutral ring ("Interrupted while writing"), and the last entry, "Canceled", has a prohibition glyph: "The goal was stopped. Work already done is kept."';
</script>

<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '10:07:10 AM',
      description: 'Goal Summarize open refunds began attempt 2',
    },
    {
      id: 'lookup',
      label: 'Looked up 4 orders',
      status: 'succeeded',
      time: '+18 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'drafting',
      label: 'Drafting the summary',
      status: 'waiting',
      time: '+1 min 5 s',
      description: 'Interrupted while writing',
    },
    {
      id: 'canceled',
      label: 'Canceled',
      status: 'cancelled',
      time: '+1 min 12 s',
      description: 'The goal was stopped. Work already done is kept.',
    },
  ];
</script>

<RunStepTimeline {steps} variant="narrative" label="What happened: canceled" />
