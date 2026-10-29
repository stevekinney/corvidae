<script lang="ts">
  /**
   * Test-only page that provides what a view reads from the shell, the way `shell.svelte` does: a
   * client, a principal store, a query client, and the engine's fleet feed, provided to the views and
   * applied to the cache for every page (the cache mapping and the task evidence). Given a component,
   * it renders that. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
  import { untrack, type Component } from 'svelte';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { connectFleetInvalidation } from '../../app/fleet-invalidation.svelte.ts';
  import { subscribeTaskEvidenceInvalidation } from '../../app/task-event-queries.ts';
  import { provideClient } from '../../lib/client.ts';
  import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import {
    AUTHORIZATION_SCOPES,
    providePrincipalStore,
    type AuthorizationScope,
  } from '../../lib/scopes.svelte.ts';

  interface Props {
    client: HttpClient;
    queryClient: QueryClient;
    fleetEvents: FleetEventSource;
    component: Component<any>;
    /** Props forwarded to the rendered component, for one that takes some. */
    componentProps?: Record<string, unknown>;
    scopes?: readonly AuthorizationScope[];
  }

  let {
    client,
    queryClient,
    fleetEvents,
    component: View,
    componentProps = {},
    scopes,
  }: Props = $props();

  const shell = untrack(() => ({ client, queryClient, fleetEvents, scopes }));
  provideClient(shell.client);
  providePrincipalStore().setPrincipal({
    scopes: shell.scopes ?? AUTHORIZATION_SCOPES,
    unauthenticatedAccess: null,
  });
  provideFleetEventSource(shell.fleetEvents);
  connectFleetInvalidation(shell.fleetEvents, shell.queryClient);
  $effect(() => subscribeTaskEvidenceInvalidation(shell.fleetEvents, shell.queryClient));
</script>

<QueryClientProvider client={queryClient}>
  <View {...componentProps} />
</QueryClientProvider>
