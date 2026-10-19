<script lang="ts">
  /**
   * Test-only harness for the task evidence panels that read their own data
   * (`task-delivery-history.svelte`, `task-dead-letter-panel.svelte`): wraps
   * one in the client, query client, and principal contexts it reads.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
  import { untrack, type Component } from 'svelte';

  import { provideClient } from '../../lib/client.ts';
  import {
    AUTHORIZATION_SCOPES,
    providePrincipalStore,
    type AuthorizationScope,
  } from '../../lib/scopes.svelte.ts';

  interface Props {
    client: HttpClient;
    queryClient: QueryClient;
    component: Component<any>;
    componentProps: Record<string, unknown>;
    principalScopes?: readonly AuthorizationScope[];
  }

  let {
    client,
    queryClient,
    component: PanelComponent,
    componentProps,
    principalScopes,
  }: Props = $props();

  provideClient(untrack(() => client));
  const principalStore = providePrincipalStore();
  principalStore.setPrincipal({
    scopes: untrack(() => principalScopes) ?? AUTHORIZATION_SCOPES,
    unauthenticatedAccess: null,
  });
</script>

<QueryClientProvider client={queryClient}>
  <PanelComponent {...componentProps} />
</QueryClientProvider>
