<script lang="ts">
  import { default as RunStepTimeline } from '@lostgradient/run-step-timeline/components/run-step-timeline/index.ts';
  import { type RunStep } from '@lostgradient/run-step-timeline/components/run-step-timeline/index.ts';

  const steps: RunStep[] = [
    {
      id: 'validate',
      label: 'Validate configuration',
      status: 'succeeded',
      startTime: '2026-06-01T11:00:00Z',
      endTime: '2026-06-01T11:01:30Z',
      duration: '1m 30s',
    },
    {
      id: 'build',
      label: 'Build Docker image',
      status: 'running',
      startTime: '2026-06-01T11:02:00Z',
      progress: 40,
    },
    {
      id: 'deploy',
      label: 'Deploy to staging',
      status: 'pending',
    },
  ];
</script>

<RunStepTimeline {steps} label="Deployment run" />
