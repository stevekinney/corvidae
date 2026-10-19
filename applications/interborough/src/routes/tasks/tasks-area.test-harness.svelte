<script lang="ts">
  /**
   * Test-only page for the Tasks area: the route outlet, with the client, principal store, and
   * query client its pages read from their ancestors. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import RouteOutlet from '../../app/shell/route-outlet.svelte';
  import { provideClient } from '../../lib/client.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import { providePrincipalStore, type AuthorizationScope } from '../../lib/scopes.svelte.ts';

  interface TasksAreaHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: TasksAreaHarnessProps = $props();

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
