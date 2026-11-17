<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunHooks`. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunHooks from './run-hooks.svelte';

  let props: ComponentProps<typeof RunHooks> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunHooks {...props} />
</QueryClientProvider>
