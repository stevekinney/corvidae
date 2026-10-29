<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + `<ScheduleDetail>` — see `schedule-list-test-harness.test-harness.svelte`'s doc for why this wrapper exists. */
  import type { HttpClient } from '@lostgradient/weft';

  import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import ScheduleDetail from './schedule-detail.svelte';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    id: string;
    scopes?: readonly AuthorizationScope[] | undefined;
    onFleetSource?: ((source: FleetEventSource) => void) | undefined;
  }

  let { client, id, scopes, onFleetSource }: Props = $props();
</script>

<SchedulesTestHarness {client} {scopes} {onFleetSource}>
  {#snippet children()}
    <ScheduleDetail {id} />
  {/snippet}
</SchedulesTestHarness>
