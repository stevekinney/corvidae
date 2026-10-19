<script lang="ts">
  /**
   * Test-only page for the Workflows area: the route outlet, with everything the area's pages read
   * from their ancestors, including the runs list's live feed, which nothing subscribes to unless
   * a test turns Live on. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import RouteOutlet from '../../app/shell/route-outlet.svelte';
  import { provideClient } from '../../lib/client.ts';
  import { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import { providePrincipalStore, type AuthorizationScope } from '../../lib/scopes.svelte.ts';

  interface AreaHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: AreaHarnessProps = $props();

  provideClient(untrack(() => client));
  providePrincipalStore().setPrincipal({
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });
  provideFleetEventSource(untrack(() => new FleetEventSource({ baseUrl: 'http://weft.test' })));
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <RouteOutlet />
</QueryClientProvider>
