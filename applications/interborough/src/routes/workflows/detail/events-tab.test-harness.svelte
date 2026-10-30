<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `EventsTab` (mirrors `tests/tanstack-query-smoke.svelte`'s pattern). */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import EventsTab from './events-tab.svelte';

  let {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ...props
  }: ComponentProps<typeof EventsTab> & { queryClient?: QueryClient } = $props();
</script>

<QueryClientProvider client={queryClient}>
  <EventsTab {...props} />
</QueryClientProvider>
