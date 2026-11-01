<script lang="ts">
  /**
   * Test-only page that mounts the plugin problems banner with the query client it reads the
   * plugins through. Never imported by production code.
   */
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { createQueryClient } from '../../lib/query.ts';
  import PluginProblemsBanner from './plugin-problems-banner.svelte';

  let { unreachable = false }: { unreachable?: boolean } = $props();

  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <PluginProblemsBanner {unreachable} />
</QueryClientProvider>
