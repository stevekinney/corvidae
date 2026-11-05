<script lang="ts" module>
  export const title = 'What happened: finished runs';
  export const description =
    'A finished run told as a story: Started has a plain grey dot and the entries after it green checks, times sit at the end of each line, and "Used Lookup order lookup-order" shows the identifier small and monospaced. The three runs are a chat reply, a run a schedule started ("The Daily summary schedule started this run at 4:00 AM (9:00 AM UTC)"), and a refund that asked for approval and was approved.';
</script>

<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const reply: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '11:20:00 AM',
      description: 'You sent a message in the chat',
    },
    {
      id: 'lookup',
      label: 'Looked up order 4468',
      status: 'succeeded',
      time: '+0.4 s',
      description: 'Used Lookup order `lookup-order` and found the order',
    },
    {
      id: 'replied',
      label: 'Replied',
      status: 'succeeded',
      time: '+22 s',
      description: 'Reply delivered to the chat',
    },
    {
      id: 'done',
      label: 'Done',
      status: 'succeeded',
      time: '+23 s',
      description: 'Finished without errors',
    },
  ];
  const schedule: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '4:00:00 AM',
      description: 'The Daily summary schedule started this run at 4:00 AM (9:00 AM UTC)',
    },
    {
      id: 'gathered',
      label: 'Gathered yesterday’s chats',
      status: 'succeeded',
      time: '+4 s',
      description: 'Read 0 chats and 0 open reviews',
    },
    {
      id: 'wrote',
      label: 'Wrote the summary',
      status: 'succeeded',
      time: '+11 s',
      description: 'Summary saved to the run result',
    },
    {
      id: 'done',
      label: 'Done',
      status: 'succeeded',
      time: '+12 s',
      description: 'Finished without errors',
    },
  ];
  const refund: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '10:30:00 AM',
      description: 'You sent a message in the chat',
    },
    {
      id: 'lookup',
      label: 'Looked up order 4472',
      status: 'succeeded',
      time: '+3 s',
      description: 'Used Lookup order `lookup-order` and found the order',
    },
    {
      id: 'asked',
      label: 'Asked for approval',
      status: 'succeeded',
      time: '+9 s',
      description: 'Issue refund `issue-refund` for $18.50 asked first',
    },
    {
      id: 'approved',
      label: 'Approved',
      status: 'succeeded',
      time: '+3 min',
      description: 'Approved by you at 10:33 AM',
    },
    {
      id: 'refunded',
      label: 'Refunded',
      status: 'succeeded',
      time: '+3 min 5 s',
      description:
        'Used Issue refund `issue-refund`. $18.50 returned to the original payment method',
    },
    {
      id: 'replied',
      label: 'Replied',
      status: 'succeeded',
      time: '+3 min 11 s',
      description: 'Reply delivered to the chat',
    },
    {
      id: 'done',
      label: 'Done',
      status: 'succeeded',
      time: '+3 min 12 s',
      description: 'Finished without errors',
    },
  ];
</script>

<div style="display: grid; gap: 2rem;">
  <RunStepTimeline steps={reply} variant="narrative" label="What happened: chat reply" />
  <RunStepTimeline steps={schedule} variant="narrative" label="What happened: schedule" />
  <RunStepTimeline steps={refund} variant="narrative" label="What happened: refund order 4472" />
</div>
