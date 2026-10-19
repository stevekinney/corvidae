<script lang="ts">
  /**
   * Test-only page that provides what the agent editor reads from its ancestors, a query client,
   * and renders the page for one agent (or a new one). The editor reads no other context. Never
   * imported by production code.
   */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import AgentEditorPage from './agent-editor-page.svelte';

  interface Props {
    /** The identifier of the agent to edit; absent for a new agent. */
    id?: string | undefined;
    /** Receives the query client the page uses, so a test can see what it invalidated. */
    onQueryClient?: ((queryClient: QueryClient) => void) | undefined;
  }

  let { id, onQueryClient }: Props = $props();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  untrack(() => onQueryClient)?.(queryClient);
</script>

<QueryClientProvider client={queryClient}>
  <AgentEditorPage {id} />
</QueryClientProvider>
