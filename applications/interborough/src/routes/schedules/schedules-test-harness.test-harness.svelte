<script lang="ts">
  /**
   * Shared component-test harness for the Schedules track. Wires the three
   * contexts every route component needs — `QueryClientProvider`
   * (`@tanstack/svelte-query`), `provideClient()`, `providePrincipalStore()`
   * — around a `children` snippet, mirroring how `src/app/app.svelte` /
   * `shell.svelte` actually provide them in the real app. Test-only; not
   * built into the production bundle (`.test-harness.svelte` is a
   * build-excluded pattern per `weft`'s conventions this repo mirrors).
   */
  import type { HttpClient } from '@lostgradient/weft';

  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import { onDestroy, untrack } from 'svelte';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import {
    installBureauStub,
    type BureauHandler,
    type BureauStub,
  } from '../../lib/bureau-stub.test-support.ts';
  import { provideClient } from '../../lib/client.ts';
  import { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import type { AuthorizationScope, Principal } from '../../lib/scopes.svelte.ts';
  import { AUTHORIZATION_SCOPES, providePrincipalStore } from '../../lib/scopes.svelte.ts';

  interface Props {
    client: HttpClient;
    children: Snippet;
    /** Defaults to every scope granted (the optimistic-grant default — `src/lib/scopes.svelte.ts` module doc). Pass a narrower list to test a denied/disabled state. */
    scopes?: readonly AuthorizationScope[] | undefined;
    /** Test-only escape hatch: hands the test the same `QueryClient` this tree uses, so it can force a real `invalidateQueries()`/refetch — e.g. to simulate a background refetch racing an open form (schedule-form-drawer.test.ts's WFT-117 round-2 regression). */
    onQueryClient?: ((queryClient: QueryClient) => void) | undefined;
    /**
     * What the Bureau answers, by operation, beside the engine the `client` talks to. A Bureau that
     * lists no schedules and no workflow files and no agents is the default, so a test of the engine's
     * own schedules needs nothing here. Replaced `fetch` is restored when the harness unmounts.
     */
    bureau?: Record<string, BureauHandler> | undefined;
    /** Hands the test the stub, to read what the Bureau was asked. */
    onBureau?: ((stub: BureauStub) => void) | undefined;
    /** The test has installed its own stand-in for the Bureau, which answers every request for it. */
    externalBureau?: boolean | undefined;
  }

  let { client, children, scopes, onQueryClient, bureau, onBureau, externalBureau }: Props =
    $props();

  if (!untrack(() => externalBureau)) {
    const bureauStub = installBureauStub(
      {
        'bureau.schedules.list': () => ({ schedules: [], nextOffset: null }),
        'bureau.workflows.list': () => ({ workflows: [], nextOffset: null }),
        'bureau.agents.list': () => ({ agents: [] }),
        ...untrack(() => bureau),
      },
      { passThrough: true },
    );
    untrack(() => onBureau)?.(bureauStub);
    onDestroy(() => bureauStub.restore());
  }

  // As the application's own client is made (`createQueryClient`): every result prop notifies, so a
  // value a page reads from a query only inside a block that renders later still follows the query.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, notifyOnChangeProps: 'all' },
      mutations: { retry: false },
    },
  });
  // One-shot, like `provideClient(untrack(() => client))` just below — this
  // harness never swaps `onQueryClient` after mount.
  untrack(() => onQueryClient)?.(queryClient);

  provideClient(untrack(() => client));
  const principalStore = providePrincipalStore();
  const principal: Principal = untrack(() => ({
    scopes: scopes ?? AUTHORIZATION_SCOPES,
    unauthenticatedAccess: null,
  }));
  principalStore.setPrincipal(principal);

  // `getFleetEventSource()` (Schedule Detail's live update — plan §9.3)
  // needs a real provided instance, not a fake object literal, since the
  // context accessor is typed against the concrete `FleetEventSource` class.
  // Reuses the SAME real server the `client` prop points at — matches this
  // track's "no mock server" testing convention throughout.
  const fleetSource = untrack(
    () => new FleetEventSource({ baseUrl: client.baseUrl, headers: client.headers }),
  );
  provideFleetEventSource(fleetSource);
  onDestroy(() => fleetSource.close());
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
