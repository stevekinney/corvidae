<script lang="ts">
  /**
   * Test-only host page: renders one exported view with only what a host can
   * supply from a client and a query client — a client from
   * `provideClient()` and a `QueryClientProvider` around
   * `createQueryClient()` — and nothing the application shell's shell provides.
   * Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack, type Component } from 'svelte';

  import { provideClient } from '../lib/client.ts';
  import { createQueryClient } from '../lib/query.ts';

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
