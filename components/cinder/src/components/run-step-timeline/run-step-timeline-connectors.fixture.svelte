<script lang="ts">
  import type { RunStep, RunStepStatus } from './run-step-timeline.types.ts';
  import RunStepTimeline from './run-step-timeline.svelte';

  const statuses: RunStepStatus[] = [
    'recorded',
    'succeeded',
    'running',
    'pending',
    'failed',
    'skipped',
    'waiting',
    'waiting_approval',
    'retrying',
    'cancelled',
    'timed-out',
    'pending',
  ];
  const longTitle =
    'Read every file the change touches, compare it against the last release, and write down what moved';

  const everyStatus: RunStep[] = statuses.map((status, index) => ({
    id: `${status}-${index}`,
    label: index === 3 ? longTitle : `Step ${index + 1}, ${status.replace('_', ' ')}`,
    status,
    description: index === 2 ? 'Still going. This line wraps under the label.' : undefined,
  }));

  const nested: RunStep[] = [
    { id: 'plan', label: 'Plan the change', status: 'succeeded' },
    {
      id: 'lane',
      label: 'Subagent lane',
      status: 'running',
      children: [
        { id: 'inspect', label: 'Inspect the diff', status: 'succeeded' },
        { id: 'verify', label: 'Run the verification again', status: 'pending' },
      ],
    },
    { id: 'archive', label: 'Archive the run', status: 'pending' },
  ];
</script>

<!-- Every marker state, a wrapped title and nested steps, in both variants, so the layout tests
     can measure each connector against the markers it joins. -->
<div class="run-step-timeline-connectors">
  <div data-testid="narrative">
    <RunStepTimeline steps={everyStatus} variant="narrative" label="Narrative" />
  </div>
  <div data-testid="detailed">
    <RunStepTimeline steps={everyStatus} label="Detailed" />
  </div>
  <div data-testid="nested">
    <RunStepTimeline steps={nested} label="Nested" />
  </div>
  <div data-testid="nested-narrative">
    <RunStepTimeline steps={nested} variant="narrative" label="Nested narrative" />
  </div>
</div>

<style>
  .run-step-timeline-connectors {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 2rem;
    padding: 1rem;
  }
</style>
