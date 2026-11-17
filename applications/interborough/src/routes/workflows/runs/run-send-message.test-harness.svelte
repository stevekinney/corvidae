<script lang="ts">
  /** Test-only harness: the query client and the toast host the message bar reads, around it. */
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import ToastHost from '../../../app/toast-host.svelte';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import RunSendMessage from './run-send-message.svelte';

  let {
    contextId,
    runId,
    task = undefined,
  }: { contextId: string; runId: string; task?: TaskView | undefined } = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <RunSendMessage {contextId} {runId} {task} />
  <ToastHost />
</QueryClientProvider>
