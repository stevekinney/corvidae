<script lang="ts" module>
  export const title = "A run's story";
  export const description =
    'The narrative variant reads steps as what happened: a marker, a label with its time, one line of description, and a streaming note while output arrives.';
</script>

<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '10:45:20 AM',
      description: 'You started Release notes from the run page',
    },
    {
      id: 'find',
      label: 'Step 1, Find the last release',
      status: 'succeeded',
      time: '+1.2 s',
      description: 'Found the last release, 1.4.2, on Oct 23',
    },
    {
      id: 'collect',
      label: 'Step 2, Collect merged changes',
      status: 'running',
      time: 'now',
      description:
        'Reading merged pull requests from GitHub. Streaming, so this entry is partial and grows.',
      note: {
        title: 'Merged since Oct 23, so far',
        lines: [
          'Fixes the refund total when an order has a promo code',
          'Adds a staging check before releases go out',
        ],
        streaming: true,
      },
    },
    {
      id: 'draft',
      label: 'Step 3, Draft the notes',
      status: 'pending',
      description: 'Waits for step 2',
    },
    {
      id: 'approve',
      label: 'Step 4, Wait for approval',
      status: 'pending',
      description: 'Waits for step 3. Resumes on the signal `notes-approved`.',
    },
  ];
</script>

<RunStepTimeline {steps} variant="narrative" label="What happened" />
