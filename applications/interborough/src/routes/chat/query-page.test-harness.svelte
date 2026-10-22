<script lang="ts">
  /**
   * Test-only page that renders a route component the way the shell does: below a query client.
   * Never imported by production code.
   */
  import { untrack, type Component } from 'svelte';

  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { createQueryClient } from '../../lib/query.ts';
  import type { QueryClient } from '@tanstack/svelte-query';

  interface QueryPageProps {
    page: Component<Record<string, unknown>>;
    pageProps?: Record<string, unknown>;
    /** A client the test holds, to see what the page has been answered. */
    client?: QueryClient;
  }

  let { page: Page, pageProps = {}, client }: QueryPageProps = $props();

  const queryClient = untrack(() => client ?? createQueryClient());
</script>

<QueryClientProvider client={queryClient}>
  <Page {...pageProps} />
</QueryClientProvider>
