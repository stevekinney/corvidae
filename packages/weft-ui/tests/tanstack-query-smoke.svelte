<script lang="ts">
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import TanstackQuerySmokeInner from './tanstack-query-smoke-inner.svelte';

  /**
   * The query consumer must mount below the provider so it receives the
   * real query client through Svelte context, just like an application route.
   */
  const queryClient = new QueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <TanstackQuerySmokeInner />
</QueryClientProvider>
