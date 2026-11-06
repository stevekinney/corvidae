<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + `<ScheduleRuns>`, over a client the test fakes. */
  import type { HttpClient, ScheduleSummary } from '@lostgradient/weft';

  import type { ConnectionMonitor } from '../../app/connection.svelte.ts';

  import ScheduleRuns from './schedule-runs.svelte';
  import type { ScheduleRow } from './schedule-row-model.ts';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    /** The shell's connection monitor, for a test of how the list reads a server that does not answer. */
    connection?: ConnectionMonitor;
    schedule: ScheduleSummary;
    row: Pick<ScheduleRow, 'status' | 'allBlockers' | 'workflowLabel'>;
    now: number;
    canSkip?: boolean;
    onSkip?: (occurrence: number) => void;
    onUnskip?: (occurrence: number) => void;
    busy?: boolean;
    runOnce?: {
      readonly reason: string | null;
      readonly disabled: boolean;
      onRun: () => void;
    } | null;
  }

  let {
    client,
    connection,
    schedule,
    row,
    now,
    canSkip = true,
    onSkip = () => undefined,
    onUnskip = () => undefined,
    busy = false,
    runOnce = null,
  }: Props = $props();
</script>

<SchedulesTestHarness {client} {connection}>
  {#snippet children()}
    <ScheduleRuns {schedule} {row} {now} {canSkip} {busy} {onSkip} {onUnskip} {runOnce} />
  {/snippet}
</SchedulesTestHarness>
