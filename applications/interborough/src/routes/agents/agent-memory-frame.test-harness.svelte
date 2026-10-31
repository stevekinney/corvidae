<script lang="ts">
  /**
   * Test-only page that renders the Memory page the way the router does: inside the Agents view's
   * frame, below a client, a principal store, and a query client. Never imported by production code.
   */
  import { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import ViewFrame from '../../app/view-frame.svelte';
  import { provideClient } from '../../lib/client.ts';
  import { AGENT_MEMORY_PATTERN, createQueryClient } from '../../lib/query.ts';
  import { AUTHORIZATION_SCOPES, providePrincipalStore } from '../../lib/scopes.svelte.ts';
  import AgentMemory from './agent-memory.svelte';

  let { agentId }: { agentId: string } = $props();

  provideClient(new HttpClient({ baseUrl: 'http://localhost/api' }));
  providePrincipalStore().setPrincipal({
    scopes: AUTHORIZATION_SCOPES,
    subject: 'tester',
    unauthenticatedAccess: null,
  });
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <ViewFrame view="agents" pattern={AGENT_MEMORY_PATTERN} parameters={{ agent: agentId }}>
    <AgentMemory />
  </ViewFrame>
</QueryClientProvider>
