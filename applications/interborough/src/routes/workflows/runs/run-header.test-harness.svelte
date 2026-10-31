<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunHeader`, whose Cancel run reads the query client. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunHeader from './run-header.svelte';

  let props: ComponentProps<typeof RunHeader> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunHeader {...props} />
</QueryClientProvider>
