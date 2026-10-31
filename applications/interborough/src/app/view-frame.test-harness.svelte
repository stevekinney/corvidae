<script lang="ts">
  /**
   * Test-only page that provides what a view frame reads from its ancestors (a client, a principal
   * store, a query client) and renders a frame around a stub of the view's content. Given the
   * shell's live feeds, it provides them and applies them to the cache as the shell does. Never
   * imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { provideClient } from '../lib/client.ts';
  import type { BureauEventSource } from '../lib/live-source/bureau-event-source.svelte.ts';
  import type { FleetEventSource } from '../lib/live-source/fleet-event-source.svelte.ts';
  import { createQueryClient } from '../lib/query.ts';
  import {
    providePrincipalStore,
    type AuthorizationScope,
    type PrincipalStore,
  } from '../lib/scopes.svelte.ts';
  import { subscribeBureauInvalidation } from './bureau-event-queries.ts';
  import { provideFleetEventSource } from './engine-status.svelte.ts';
  import { ConnectionMonitor, guardChanges, provideConnection } from './connection.svelte.ts';
  import { connectFleetInvalidation } from './fleet-invalidation.svelte.ts';
  import { provideBureauEventSource } from './live-polling.svelte.ts';
  import ToastHost from './toast-host.svelte';
  import ViewFrame from './view-frame.svelte';
  import type { ViewName } from './views.ts';

  interface ViewFrameHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
    view: ViewName;
    parameters?: Readonly<Record<string, string>>;
    /** The matched route's pattern, for a view whose routes ask different questions. */
    pattern?: string;
    /** Receives the principal store the frame reads, so a test can watch a scope being revoked. */
    onStore?: (store: PrincipalStore) => void;
    /** Receives the query client the frame reads, so a test can wait on a query's own state. */
    onQueryClient?: (client: QueryClient) => void;
    /** The shell's Bureau feed, provided to the frame and applied to the cache. */
    bureauEvents?: BureauEventSource;
    /** The shell's engine feed, provided to the frame and applied to the cache. */
    fleetEvents?: FleetEventSource;
    /**
     * Gives the frame the shell's connection monitor, whose probe of the host is this function. It
     * watches the frame's query cache and refetches what the frame kept once the host answers.
     */
    probeHost?: () => Promise<unknown>;
    /** Receives the monitor, so a test can read whether the host is reachable. */
    onConnection?: (monitor: ConnectionMonitor) => void;
  }

  let {
    client,
    scopes,
    view,
    parameters = {},
    pattern,
    onStore,
    onQueryClient,
    bureauEvents,
    fleetEvents,
    probeHost,
    onConnection,
  }: ViewFrameHarnessProps = $props();

  provideClient(untrack(() => client));
  const store = providePrincipalStore();
  store.setPrincipal({
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });
  untrack(() => onStore)?.(store);
  const queryClient = createQueryClient();
  untrack(() => onQueryClient)?.(queryClient);
  const probeHostFunction = untrack(() => probeHost);
  if (probeHostFunction !== undefined) {
    const monitor = provideConnection(
      new ConnectionMonitor({
        probe: probeHostFunction,
        onRecovered: () => void queryClient.invalidateQueries(),
        probeDelayMs: () => 5,
      }),
    );
    untrack(() => onConnection)?.(monitor);
    $effect(() => {
      const stopObserving = monitor.observe(queryClient);
      const stopGuarding = guardChanges(queryClient, monitor);
      return () => {
        stopObserving();
        stopGuarding();
        monitor.dispose();
      };
    });
  }
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
  {#if probeHostFunction !== undefined}<ToastHost />{/if}
  <ViewFrame {view} {parameters} {pattern}>
    <p data-testid="content">The {view} view’s content.</p>
  </ViewFrame>
</QueryClientProvider>
