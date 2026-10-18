<script lang="ts">
  /**
   * Test-only page that provides what the route outlet's views read from their ancestors (a
   * client, a principal store, a query client). Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { provideClient } from '../../lib/client.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import { providePrincipalStore, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import RouteOutlet from './route-outlet.svelte';

  interface RouteOutletHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: RouteOutletHarnessProps = $props();

  provideClient(untrack(() => client));
  providePrincipalStore().setPrincipal({
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <RouteOutlet />
</QueryClientProvider>
