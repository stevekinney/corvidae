<script lang="ts">
  /** Test-only harness giving `UpdatesTab` the `QueryClientProvider` it reads. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import UpdatesTab from './updates-tab.svelte';

  interface Props extends ComponentProps<typeof UpdatesTab> {
    queryClient?: QueryClient;
  }

  let {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ...props
  }: Props = $props();
</script>

<QueryClientProvider client={queryClient}>
  <UpdatesTab {...props} />
</QueryClientProvider>
