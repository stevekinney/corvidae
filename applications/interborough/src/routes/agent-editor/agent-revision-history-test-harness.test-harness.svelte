<script lang="ts">
  /** Test-only page that provides a query client around the revision history. Never imported by production code. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import AgentRevisionHistory from './agent-revision-history.svelte';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <AgentRevisionHistory {id} />
</QueryClientProvider>
