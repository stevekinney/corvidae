<script lang="ts">
  /** Test-only harness giving `AttributesPanel` the `QueryClientProvider` it reads. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { ComponentProps } from 'svelte';

  import AttributesPanel from './attributes-panel.svelte';

  let props: ComponentProps<typeof AttributesPanel> = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <AttributesPanel {...props} />
</QueryClientProvider>
