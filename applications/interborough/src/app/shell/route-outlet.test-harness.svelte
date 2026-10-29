<script lang="ts">
  /**
   * Test-only page that provides what the route outlet's views read from their ancestors (a
   * client, a principal store, a query client). Given the shell's live feeds, it provides them and
   * applies them to the cache as the shell does. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { subscribeBureauInvalidation } from '../bureau-event-queries.ts';
  import { provideFleetEventSource } from '../engine-status.svelte.ts';
  import { connectFleetInvalidation } from '../fleet-invalidation.svelte.ts';
  import { provideBureauEventSource } from '../live-polling.svelte.ts';
  import { provideClient } from '../../lib/client.ts';
  import type { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
  import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
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
    /** The shell's Bureau feed, provided to the views and applied to the cache. */
    bureauEvents?: BureauEventSource;
    /** The shell's engine feed, provided to the views and applied to the cache. */
    fleetEvents?: FleetEventSource;
  }

  let { client, scopes, bureauEvents, fleetEvents }: RouteOutletHarnessProps = $props();

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
  const feeds = untrack(() => ({ bureauEvents, fleetEvents }));
  if (feeds.bureauEvents !== undefined) {
    const source = feeds.bureauEvents;
    provideBureauEventSource(source);
    $effect(() => subscribeBureauInvalidation(source, queryClient));
  }
  if (feeds.fleetEvents !== undefined) {
    provideFleetEventSource(feeds.fleetEvents);
    connectFleetInvalidation(feeds.fleetEvents, queryClient);
  }
</script>

<QueryClientProvider client={queryClient}>
  <RouteOutlet />
  <ToastHost />
</QueryClientProvider>
