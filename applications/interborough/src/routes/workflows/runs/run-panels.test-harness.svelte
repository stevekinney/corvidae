<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunPanels`, to mount it for a run the test names. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunPanels from './run-panels.svelte';

  let props: ComponentProps<typeof RunPanels> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunPanels {...props} />
</QueryClientProvider>
