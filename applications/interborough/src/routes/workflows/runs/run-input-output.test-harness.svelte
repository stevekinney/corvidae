<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunInputOutput`, which reads the chat thread and the things a payload names. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunInputOutput from './run-input-output.svelte';

  let props: ComponentProps<typeof RunInputOutput> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunInputOutput {...props} />
</QueryClientProvider>
