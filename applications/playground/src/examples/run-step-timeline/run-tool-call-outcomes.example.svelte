<script lang="ts" module>
  export const title = 'What happened: a failed call and a denied approval';
  export const description =
    'A run that is Done keeps a failed tool call visible: its entry has a red mark and an open note, "This call failed", and the run still ends "Finished; one tool call failed". After a denied approval the entry reads Denied with a neutral dot, the note you typed shows as "Your note · …", and the run ends "Done · refund not issued".';
</script>

<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const failedCall: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '9:12:00 AM',
      description: 'You sent a message in the chat',
    },
    {
      id: 'lookup-4469',
      label: 'Looked up order 4469',
      status: 'succeeded',
      time: '+1 s',
      description: 'Used Lookup order `lookup-order` and found the order',
    },
    {
      id: 'lookup-4470',
      label: 'Looked up order 4470',
      status: 'failed',
      time: '+3 s',
      description: 'Used Lookup order `lookup-order`',
      note: {
        tone: 'danger',
        title: 'This call failed',
        lines: [
          'Lookup order didn’t answer (HTTP 503) for order 4470. The agent carried on and said so in its reply.',
        ],
      },
    },
    {
      id: 'replied',
      label: 'Replied',
      status: 'succeeded',
      time: '+8 s',
      description: 'Told you what it found and what it couldn’t',
    },
    {
      id: 'done',
      label: 'Done',
      status: 'succeeded',
      time: '+9 s',
      description: 'Finished; one tool call failed',
    },
  ];
  const denied: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '9:20:00 AM',
      description: 'You sent a message in the chat',
    },
    {
      id: 'lookup',
      label: 'Looked up order 4473',
      status: 'succeeded',
      time: '+3 s',
      description: 'Used Lookup order `lookup-order` and found the order',
    },
    {
      id: 'asked',
      label: 'Asked for approval',
      status: 'succeeded',
      time: '+9 s',
      description: 'Issue refund `issue-refund` for $12.00 asked first',
    },
    {
      id: 'denied',
      label: 'Denied',
      status: 'recorded',
      time: '+58 s',
      description: 'Denied by you at 9:21 AM',
      note: { label: 'Your note', lines: ['The customer already got a replacement.'] },
    },
    {
      id: 'replied',
      label: 'Replied',
      status: 'succeeded',
      time: '+1 min',
      description: 'Told you the refund wasn’t issued, and why',
    },
    {
      id: 'done',
      label: 'Done · refund not issued',
      status: 'recorded',
      time: '+1 min 2 s',
      description: 'The run finished without issuing the refund',
    },
  ];
</script>

<div style="display: grid; gap: 2rem;">
  <RunStepTimeline steps={failedCall} variant="narrative" label="What happened: a failed call" />
  <RunStepTimeline steps={denied} variant="narrative" label="What happened: a denied approval" />
</div>
