<script lang="ts" module>
  export const title = 'What happened: waiting and checking';
  export const description =
    'A run waiting for you draws an amber ring on "Asked a question" with "Waiting for your answer", and "Next steps" dashed ("Continue once you’ve answered"). A goal attempt that finished is checked against the goal’s check: its entries have no outcome yet, so they are plain grey dots, and the last entry, "Checking the result now", is a hollow in-progress ring.';
</script>

<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const waiting: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '9:46:03 AM',
      description: 'You sent a message in the chat',
    },
    {
      id: 'asked',
      label: 'Asked a question',
      status: 'waiting_approval',
      time: '+4 s',
      description: 'Waiting for your answer',
    },
    {
      id: 'next',
      label: 'Next steps',
      status: 'pending',
      description: 'Continue once you’ve answered',
    },
  ];
  const checking: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '10:44:00 AM',
      description: 'Goal Summarize open refunds began attempt 2',
    },
    {
      id: 'lookup',
      label: 'Looked up 4 orders',
      status: 'recorded',
      time: '+18 s',
      description: 'Used Lookup order `lookup-order`',
    },
    {
      id: 'wrote',
      label: 'Wrote the summary',
      status: 'recorded',
      time: '+1 min 12 s',
      description: 'The agent finished. Its result is being checked against the goal’s check.',
    },
    {
      id: 'checking',
      label: 'Checking the result now',
      status: 'running',
      time: 'now',
      description:
        'Waiting for the check to say whether the summary lists every refund waiting for approval',
    },
  ];
</script>

<div style="display: grid; gap: 2rem;">
  <RunStepTimeline steps={waiting} variant="narrative" label="What happened: waiting for you" />
  <RunStepTimeline
    steps={checking}
    variant="narrative"
    label="What happened: checking the result"
  />
</div>
