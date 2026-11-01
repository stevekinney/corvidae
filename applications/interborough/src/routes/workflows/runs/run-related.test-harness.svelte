<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunRelated`. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunRelated from './run-related.svelte';

  let props: ComponentProps<typeof RunRelated> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunRelated {...props} />
</QueryClientProvider>
