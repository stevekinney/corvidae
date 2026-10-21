<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + the Schedules domain router (`index.svelte`). */
  import type { HttpClient } from '@lostgradient/weft';
  import type { QueryClient } from '@tanstack/svelte-query';

  import SchedulesIndex from './index.svelte';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';

  interface Props {
    client: HttpClient;
    scopes?: readonly AuthorizationScope[] | undefined;
    /** The test has installed its own stand-in for the Bureau. */
    externalBureau?: boolean | undefined;
    /** Hands the test the tree's `QueryClient`, so it can force a refetch while something is open. */
    onQueryClient?: ((queryClient: QueryClient) => void) | undefined;
  }

  let { client, scopes, externalBureau, onQueryClient }: Props = $props();
</script>

<SchedulesTestHarness {client} {scopes} {externalBureau} {onQueryClient}>
  {#snippet children()}
    <SchedulesIndex />
  {/snippet}
</SchedulesTestHarness>
