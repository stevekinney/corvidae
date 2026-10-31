<script lang="ts">
  /** Test-only composition of `<DashboardTestHarness>` + `<HealthLine>`. */
  import type { HttpClient } from '@lostgradient/weft';
  import type { QueryClient } from '@tanstack/svelte-query';

  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import HealthLine from './health-line.svelte';
  import DashboardTestHarness from './dashboard-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    scopes?: readonly AuthorizationScope[] | undefined;
    onQueryClientReady?: ((queryClient: QueryClient) => void) | undefined;
  }

  let { client, scopes, onQueryClientReady }: Props = $props();
</script>

<DashboardTestHarness {client} {scopes} {onQueryClientReady}>
  {#snippet children()}
    <HealthLine />
  {/snippet}
</DashboardTestHarness>
