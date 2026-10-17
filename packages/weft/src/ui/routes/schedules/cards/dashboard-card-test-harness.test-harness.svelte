<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + the Schedule health dashboard card. */
  import type { HttpClient } from '@lostgradient/weft';

  import type { AuthorizationScope } from '../../../lib/scopes.svelte.ts';
  import SchedulesTestHarness from '../schedules-test-harness.test-harness.svelte';
  import DashboardCard from './dashboard-card.svelte';

  interface Props {
    client: HttpClient;
    scopes?: readonly AuthorizationScope[] | undefined;
  }

  let { client, scopes }: Props = $props();
</script>

<SchedulesTestHarness {client} {scopes}>
  {#snippet children()}
    <DashboardCard />
  {/snippet}
</SchedulesTestHarness>
