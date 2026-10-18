<script lang="ts">
  /**
   * Test-only page that, like the application shell's shell, already provides a
   * principal store, a fleet event source, and a toast host above the view.
   * Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onDestroy, untrack, type Component } from 'svelte';

  import { provideFleetEventSource } from '../app/engine-status.svelte.ts';
  import { provideToastHost } from '../app/toast-host.svelte';
  import { provideClient } from '../lib/client.ts';
  import { FleetEventSource } from '../lib/live-source/index.ts';
  import { createQueryClient } from '../lib/query.ts';
  import { providePrincipalStore, type AuthorizationScope } from '../lib/scopes.svelte.ts';

  interface ProvidedHostPageProps {
    client: HttpClient;
    view: Component;
    scopes: readonly AuthorizationScope[];
  }

  let { client, view: View, scopes }: ProvidedHostPageProps = $props();

  const initialClient = untrack(() => client);
  provideClient(initialClient);
  providePrincipalStore().setPrincipal({
    scopes: untrack(() => scopes),
    unauthenticatedAccess: null,
  });
  const fleetSource = new FleetEventSource({
    baseUrl: initialClient.baseUrl,
    headers: initialClient.headers,
  });
  provideFleetEventSource(fleetSource);
  onDestroy(() => fleetSource.close());
  provideToastHost();
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <View />
</QueryClientProvider>
