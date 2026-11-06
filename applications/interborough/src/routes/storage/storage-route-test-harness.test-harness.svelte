<script lang="ts">
  /**
   * Test-only harness mounting the real Storage route (`./index.svelte`)
   * under the Svelte context it needs at runtime — mirrors the pattern
   * `src/routes/reviews/reviews-test-harness.test-harness.svelte` documents
   * (a harness renders ONE fixed subject, not an arbitrary snippet). Never
   * imported by production code.
   */
  import { setContext, untrack } from 'svelte';

  import type { HttpClient } from '@lostgradient/weft';

  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import { provideClient } from '../../lib/client.ts';
  import { providePrincipalStore, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import StorageRoute from './index.svelte';
  import { STORAGE_WATCH_INTERVAL } from './queries.ts';

  interface StorageRouteTestHarnessProps {
    client: HttpClient;
    scopes?: readonly AuthorizationScope[];
    /** How often an open editor reads its key again; never unless a test asks for it. */
    watchInterval?: number | false;
  }

  let {
    client,
    scopes = ['storage:admin'],
    watchInterval = false,
  }: StorageRouteTestHarnessProps = $props();

  setContext(
    STORAGE_WATCH_INTERVAL,
    untrack(() => watchInterval),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  provideClient(untrack(() => client));
  const principalStore = providePrincipalStore();
  principalStore.setPrincipal({ scopes: untrack(() => scopes), unauthenticatedAccess: null });
</script>

<QueryClientProvider client={queryClient}>
  <StorageRoute />
</QueryClientProvider>
