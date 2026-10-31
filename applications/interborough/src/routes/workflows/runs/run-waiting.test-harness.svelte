<script lang="ts">
  /**
   * Test-only harness that gives a run's waiting section the query client it reads from its
   * ancestors, so a test can hand it a task and then a later read of the same task. Never imported
   * by production code.
   */
  import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';

  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import RunWaiting from './run-waiting.svelte';

  interface Props {
    task: TaskView;
    queryClient: QueryClient;
  }

  let { task, queryClient }: Props = $props();
</script>

<QueryClientProvider client={queryClient}>
  <RunWaiting {task} />
</QueryClientProvider>
