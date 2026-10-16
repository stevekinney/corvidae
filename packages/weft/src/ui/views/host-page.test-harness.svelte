<script lang="ts">
  /**
   * Test-only host page: renders one exported view with only what a host can
   * supply from `@lostgradient/weft/ui`'s export list — a client from
   * `provideClient()` and a `QueryClientProvider` around
   * `createQueryClient()` — and nothing `WeftDashboard`'s shell provides.
   * Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack, type Component } from 'svelte';

  import { createQueryClient, provideClient } from '../index.ts';

  interface HostPageProps {
    client: HttpClient;
    view: Component;
  }

  let { client, view: View }: HostPageProps = $props();

  provideClient(untrack(() => client));
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <View />
</QueryClientProvider>
