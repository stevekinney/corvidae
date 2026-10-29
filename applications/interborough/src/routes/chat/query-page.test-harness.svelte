<script lang="ts">
  /**
   * Test-only page that renders a route component the way the shell does: below a query client.
   * Never imported by production code.
   */
  import { untrack, type Component } from 'svelte';

  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { subscribeBureauInvalidation } from '../../app/bureau-event-queries.ts';
  import { provideBureauEventSource } from '../../app/live-polling.svelte.ts';
  import type { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import type { QueryClient } from '@tanstack/svelte-query';

  interface QueryPageProps {
    page: Component<Record<string, unknown>>;
    pageProps?: Record<string, unknown>;
    /** A client the test holds, to see what the page has been answered. */
    client?: QueryClient;
    /** The shell's Bureau event source, provided and applied to the cache as the shell does. */
    bureauEvents?: BureauEventSource;
  }

  let { page: Page, pageProps = {}, client, bureauEvents }: QueryPageProps = $props();

  const queryClient = untrack(() => client ?? createQueryClient());
  const events = untrack(() => bureauEvents);
  if (events !== undefined) provideBureauEventSource(events);
  $effect(() =>
    events === undefined ? undefined : subscribeBureauInvalidation(events, queryClient),
  );
</script>

<QueryClientProvider client={queryClient}>
  <Page {...pageProps} />
</QueryClientProvider>
