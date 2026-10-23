<script lang="ts">
  /**
   * Test-only page that holds the event count a run's stream would report, so a test can raise it
   * without remounting the tool calls. Never imported by production code.
   */
  import { untrack } from 'svelte';

  import { QueryClientProvider } from '@tanstack/svelte-query';

  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import { createQueryClient } from '../../../lib/query.ts';
  import RunToolCalls from './run-tool-calls.svelte';

  interface HarnessProps {
    task: TaskView;
  }

  let { task }: HarnessProps = $props();

  let events = $state(0);
  const queryClient = untrack(() => createQueryClient());
</script>

<QueryClientProvider client={queryClient}>
  <button type="button" onclick={() => (events += 1)}>Report an event</button>
  <RunToolCalls {task} {events} />
</QueryClientProvider>
