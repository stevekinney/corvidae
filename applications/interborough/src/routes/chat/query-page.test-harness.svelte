<script lang="ts">
  /**
   * Test-only page that renders a route component the way the shell does: below a query client.
   * Never imported by production code.
   */
  import type { Component } from 'svelte';

  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { createQueryClient } from '../../lib/query.ts';

  interface QueryPageProps {
    page: Component<Record<string, unknown>>;
    pageProps?: Record<string, unknown>;
  }

  let { page: Page, pageProps = {} }: QueryPageProps = $props();

  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <Page {...pageProps} />
</QueryClientProvider>
