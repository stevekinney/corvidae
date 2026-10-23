<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + `<ScheduleLastFire>`, to follow one schedule's last-run glyph as fleet frames arrive. */
  import type { HttpClient } from '@lostgradient/weft';

  import type { QueryClient } from '@tanstack/svelte-query';

  import ScheduleLastFire from './schedule-last-fire.svelte';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    scheduleId: string;
    lastFireAt: number | undefined;
    onQueryClient?: ((queryClient: QueryClient) => void) | undefined;
  }

  let { client, scheduleId, lastFireAt, onQueryClient }: Props = $props();
</script>

<SchedulesTestHarness {client} {onQueryClient}>
  {#snippet children()}
    <ScheduleLastFire {scheduleId} {lastFireAt} />
  {/snippet}
</SchedulesTestHarness>
