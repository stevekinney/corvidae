<script lang="ts">
  /**
   * Component-test harness for Home. Wires the four contexts every route component needs —
   * `QueryClientProvider` (`@tanstack/svelte-query`), `provideClient()`,
   * `providePrincipalStore()`, `provideFleetEventSource()` — around a `children` snippet,
   * mirroring `src/app/app.svelte`/`shell.svelte`'s real provisioning, as
   * `src/routes/schedules/schedules-test-harness.test-harness.svelte` does.
   */
  import type { HttpClient } from '@lostgradient/weft';

  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import { onDestroy, untrack } from 'svelte';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { provideClient } from '../../lib/client.ts';
  import { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import type { AuthorizationScope, Principal } from '../../lib/scopes.svelte.ts';
  import { AUTHORIZATION_SCOPES, providePrincipalStore } from '../../lib/scopes.svelte.ts';

  interface Props {
    client: HttpClient;
    children: Snippet;
    /** Defaults to every scope granted (the optimistic-grant default). Pass a narrower list to test a denied/disabled state. */
    scopes?: readonly AuthorizationScope[] | undefined;
    onQueryClientReady?: ((queryClient: QueryClient) => void) | undefined;
    /** The server-resolved identity the browser keeps its per-person choices under; none keeps nothing. */
    workspace?: Principal['workspace'] | undefined;
  }

  let { client, children, scopes, onQueryClientReady, workspace }: Props = $props();

  const queryClient = new QueryClient({
    defaultOptions: {
      // `notifyOnChangeProps: 'all'` matches the production `createQueryClient()`
      // (`src/lib/query.ts`) — without it, TanStack Query's tracked-properties
      // optimization can silently stop notifying a component whose derived
      // logic reads a result property conditionally (e.g. short-circuited on
      // a scope check), so a settled query never reaches the DOM. See
      // `src/lib/query.ts`'s `createQueryClient()` doc for the full story.
      queries: { retry: false, notifyOnChangeProps: 'all' },
      mutations: { retry: false },
    },
  });
  untrack(() => onQueryClientReady?.(queryClient));

  provideClient(untrack(() => client));
  const principalStore = providePrincipalStore();
  const principal: Principal = untrack(() => ({
    scopes: scopes ?? AUTHORIZATION_SCOPES,
    unauthenticatedAccess: null,
    ...(workspace === undefined ? {} : { workspace }),
  }));
  principalStore.setPrincipal(principal);

  const fleetSource = untrack(
    () => new FleetEventSource({ baseUrl: client.baseUrl, headers: client.headers }),
  );
  provideFleetEventSource(fleetSource);
  onDestroy(() => fleetSource.close());
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
