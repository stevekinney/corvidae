<script lang="ts">
  /**
   * Test-only harness giving `UpdatesTab` the `QueryClientProvider` it reads, and, when a test passes
   * a fleet source, the shell's wiring of it: provided to the tree and applied to the cache.
   */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack, type ComponentProps } from 'svelte';

  import { provideFleetEventSource } from '../../../app/engine-status.svelte.ts';
  import { connectFleetInvalidation } from '../../../app/fleet-invalidation.svelte.ts';
  import type { FleetEventSource } from '../../../lib/live-source/fleet-event-source.svelte.ts';
  import UpdatesTab from './updates-tab.svelte';

  interface Props extends ComponentProps<typeof UpdatesTab> {
    queryClient?: QueryClient;
    fleetEvents?: FleetEventSource;
  }

  let {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    fleetEvents,
    ...props
  }: Props = $props();

  const wired = untrack(() => ({ fleetEvents, queryClient }));
  if (wired.fleetEvents !== undefined) {
    provideFleetEventSource(wired.fleetEvents);
    connectFleetInvalidation(wired.fleetEvents, wired.queryClient);
  }
</script>

<QueryClientProvider client={queryClient}>
  <UpdatesTab {...props} />
</QueryClientProvider>
