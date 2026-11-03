<script lang="ts" module>
  export const title = 'Progress by step';
  export const description =
    'variant="status" lists what is done, what is running and what is waiting, as a status region that announces changes.';
</script>

<script lang="ts">
  import { type StepItem, Steps } from '@lostgradient/cinder';

  const steps: StepItem[] = [
    { id: 'saved', label: 'Saved your choice', done: true },
    { id: 'stopped', label: 'Stopped the server', done: true },
    { id: 'starting', label: 'Starting Interborough' },
    { id: 'plugins', label: 'Checking plugins' },
  ];
</script>

<Steps {steps} variant="status" label="Restart progress" />
