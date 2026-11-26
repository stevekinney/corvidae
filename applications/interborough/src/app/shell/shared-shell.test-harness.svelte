<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { HttpClient } from '@lostgradient/weft';
  import { createQueryClient } from '../../lib/query.ts';
  import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
  import Shell from './shell.svelte';

  const queryClient = createQueryClient();
  const client = new HttpClient({ baseUrl: 'http://localhost/api' });
  const principal = {
    method: 'browser-session' as const,
    scopes: AUTHORIZATION_SCOPES,
    subject: 'administrator',
    unauthenticatedAccess: null,
    workspace: { workspaceId: 'workspace', actorId: 'administrator', membershipRevision: 'one' },
  };
</script>

<QueryClientProvider client={queryClient}>
  <Shell
    {client}
    initialPrincipal={principal}
    onAuthExpired={() => {}}
    onIdentityMismatch={() => {}}
  />
</QueryClientProvider>
