<script lang="ts">
  /** Test-only page for `RunTaskLink`: a query client around it. Never imported by production code. */
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { createQueryClient } from '../../../lib/query.ts';
  import RunTaskLink from './run-task-link.svelte';

  interface RunTaskLinkHarnessProps {
    runId: string;
  }

  let { runId }: RunTaskLinkHarnessProps = $props();

  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <RunTaskLink {runId} />
</QueryClientProvider>
