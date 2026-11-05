<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + `<ScheduleRuns>`, over a client the test fakes. */
  import type { HttpClient, ScheduleSummary } from '@lostgradient/weft';

  import ScheduleRuns from './schedule-runs.svelte';
  import type { ScheduleRow } from './schedule-row-model.ts';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    schedule: ScheduleSummary;
    row: Pick<ScheduleRow, 'status' | 'allBlockers' | 'workflowLabel'>;
    now: number;
    canSkip?: boolean;
    onSkip?: (occurrence: number) => void;
    runOnce?: {
      readonly reason: string | null;
      readonly disabled: boolean;
      onRun: () => void;
    } | null;
  }

  let {
    client,
    schedule,
    row,
    now,
    canSkip = true,
    onSkip = () => undefined,
    runOnce = null,
  }: Props = $props();
</script>

<SchedulesTestHarness {client}>
  {#snippet children()}
    <ScheduleRuns {schedule} {row} {now} {canSkip} busy={false} {onSkip} {runOnce} />
  {/snippet}
</SchedulesTestHarness>
