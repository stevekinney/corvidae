<script lang="ts">
  /**
   * Test-only page for `/reviews` with the navigation beside it: the sidebar and the route outlet
   * under one query client, as the shell has them, so a decision made on the page can be seen
   * changing the count in the navigation. Never imported by production code.
   */
  import { onDestroy, untrack } from 'svelte';

  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import RouteOutlet from '../../app/shell/route-outlet.svelte';
  import ToastHost, { provideToastHost } from '../../app/toast-host.svelte';
  import Sidebar from '../../app/shell/sidebar.svelte';
  import { provideClient } from '../../lib/client.ts';
  import { FleetEventSource } from '../../lib/live-source/index.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import {
    providePrincipalStore,
    type AuthorizationScope,
    type PrincipalStore,
  } from '../../lib/scopes.svelte.ts';

  interface ReviewsShellHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
    onPrincipal?: (store: PrincipalStore) => void;
  }

  let { client, scopes, onPrincipal }: ReviewsShellHarnessProps = $props();

  const initialClient = untrack(() => client);
  provideClient(initialClient);
  const principal = providePrincipalStore();
  principal.setPrincipal({
    workspace: { workspaceId: 'workspace-a', actorId: 'actor-a' },
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });
  onPrincipal?.(principal);
  const fleetSource = new FleetEventSource({
    baseUrl: initialClient.baseUrl,
    headers: initialClient.headers,
  });
  provideFleetEventSource(fleetSource);
  onDestroy(() => fleetSource.close());
  const queryClient = createQueryClient();
  // A failed mutation reports itself as a toast, as it does under the shell.
  provideToastHost();
</script>

<QueryClientProvider client={queryClient}>
  <Sidebar />
  <RouteOutlet />
  <ToastHost />
</QueryClientProvider>
