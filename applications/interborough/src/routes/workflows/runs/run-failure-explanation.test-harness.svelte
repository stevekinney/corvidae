<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunFailureExplanation`, which reads `bureau.tasks.explain`. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunFailureExplanation from './run-failure-explanation.svelte';

  let props: ComponentProps<typeof RunFailureExplanation> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunFailureExplanation {...props} />
</QueryClientProvider>
