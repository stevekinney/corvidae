<script lang="ts">
  /** Test-only composition of the shared route harness (clients, queries, principal) around Home. */
  import type { HttpClient } from '@lostgradient/weft';

  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import DashboardTestHarness from '../dashboard/dashboard-test-harness.test-harness.svelte';
  import Home from './index.svelte';

  interface Props {
    client: HttpClient;
    scopes?: readonly AuthorizationScope[] | undefined;
  }

  let { client, scopes }: Props = $props();
</script>

<DashboardTestHarness {client} {scopes}>
  {#snippet children()}
    <Home />
  {/snippet}
</DashboardTestHarness>
