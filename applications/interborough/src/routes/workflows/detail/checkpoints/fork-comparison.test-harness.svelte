<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `ForkComparison` (the lineage panel's harness does the same). */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import ForkComparison from './fork-comparison.svelte';

  let props: ComponentProps<typeof ForkComparison> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <ForkComparison {...props} />
</QueryClientProvider>
