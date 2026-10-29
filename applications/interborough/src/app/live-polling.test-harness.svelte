<script lang="ts">
  /**
   * Test-only harness that wires the shell's two live sources the way `shell.svelte` does (provided
   * to the tree, and applied to the cache for every page) around the review queries that follow
   * them. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import type { BureauEventSource } from '../lib/live-source/bureau-event-source.svelte.ts';
  import type { FleetEventSource } from '../lib/live-source/fleet-event-source.svelte.ts';
  import LivePollingReviews from './live-polling-reviews.test-harness.svelte';
  import { subscribeBureauInvalidation } from './bureau-event-queries.ts';
  import { provideFleetEventSource } from './engine-status.svelte.ts';
  import { connectFleetInvalidation } from './fleet-invalidation.svelte.ts';
  import { provideBureauEventSource } from './live-polling.svelte.ts';

  interface Props {
    queryClient: QueryClient;
    client: Pick<HttpClient, 'listReviews'>;
    bureauEvents: BureauEventSource;
    fleetEvents: FleetEventSource;
  }

  let { queryClient, client, bureauEvents, fleetEvents }: Props = $props();

  const sources = untrack(() => ({ bureauEvents, fleetEvents, queryClient }));
  provideBureauEventSource(sources.bureauEvents);
  provideFleetEventSource(sources.fleetEvents);
  connectFleetInvalidation(sources.fleetEvents, sources.queryClient);
  $effect(() => subscribeBureauInvalidation(sources.bureauEvents, sources.queryClient));
</script>

<QueryClientProvider client={queryClient}>
  <LivePollingReviews {client} />
</QueryClientProvider>
