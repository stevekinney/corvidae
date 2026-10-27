<script lang="ts">
  /**
   * Test-only page that provides what the route outlet's views read from their ancestors (a
   * client, a principal store, a query client). Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { provideClient } from '../../lib/client.ts';
  import ToastHost, { provideToastHost } from '../toast-host.svelte';
  import { createQueryClient } from '../../lib/query.ts';
  import { providePrincipalStore, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import RouteOutlet from './route-outlet.svelte';
  // Every route's component, loaded before any test that mounts this harness starts its clock.
  // The import is what loads them; the harness only names the result so the import stays.
  import { routeComponents } from './route-modules.test-support.ts';

  interface RouteOutletHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: RouteOutletHarnessProps = $props();

  void routeComponents;

  // The shell mounts the toast host, so a write that fails has somewhere to say so.
  provideToastHost();

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
  <ToastHost />
</QueryClientProvider>
