<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RunTags`, which writes through mutations. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RunTags from './run-tags.svelte';

  let props: ComponentProps<typeof RunTags> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunTags {...props} />
</QueryClientProvider>
