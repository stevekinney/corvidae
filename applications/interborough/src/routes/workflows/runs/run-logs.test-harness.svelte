<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunLogs`. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunLogs from './run-logs.svelte';

  let props: ComponentProps<typeof RunLogs> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunLogs {...props} />
</QueryClientProvider>
