<script lang="ts">
  /** Test-only harness wrapping `QueryClientProvider` around `RemoteActivityPanel`. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import RemoteActivityPanel from './remote-activity-panel.svelte';

  let props: ComponentProps<typeof RemoteActivityPanel> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RemoteActivityPanel {...props} />
</QueryClientProvider>
