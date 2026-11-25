<script lang="ts">
  /**
   * Test-only page that renders the Memory tab's body the way the router does: inside the Agents
   * view's frame, below a client, a principal store, and a query client. Never imported by
   * production code.
   */
  import { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import ViewFrame from '../../app/view-frame.svelte';
  import { provideClient } from '../../lib/client.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import { AUTHORIZATION_SCOPES, providePrincipalStore } from '../../lib/scopes.svelte.ts';
  import AgentMemory from './agent-memory.svelte';

  let {
    agentId,
    subject = 'tester',
    memorySharing = true,
  }: { agentId: string; subject?: string; memorySharing?: boolean } = $props();

  provideClient(new HttpClient({ baseUrl: 'http://localhost/api' }));
  const principalStore = providePrincipalStore();
  $effect(() => {
    principalStore.setPrincipal({
      scopes: AUTHORIZATION_SCOPES,
      subject,
      unauthenticatedAccess: null,
      workspace: { workspaceId: 'test-workspace', actorId: 'tester', memorySharing },
    });
  });
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <ViewFrame view="agents" pattern="/agents/:agent/memory" parameters={{ agent: agentId }}>
    <AgentMemory />
  </ViewFrame>
</QueryClientProvider>
