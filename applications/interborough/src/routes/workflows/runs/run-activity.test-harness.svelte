<script lang="ts">
  /** Test-only wrapper that exposes the stream reread trigger for RunActivity. */
  import { untrack } from 'svelte';

  import { QueryClientProvider } from '@tanstack/svelte-query';

  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import { createQueryClient } from '../../../lib/query.ts';
  import { AUTHORIZATION_SCOPES, providePrincipalStore } from '../../../lib/scopes.svelte.ts';
  import RunActivity from './run-activity.svelte';

  interface HarnessProps {
    task: TaskView;
    threadId?: string | null | undefined;
  }

  let { task, threadId = undefined }: HarnessProps = $props();
  let taskEvents = $state(0);
  const queryClient = untrack(() => createQueryClient());
  providePrincipalStore().setPrincipal({
    scopes: AUTHORIZATION_SCOPES,
    unauthenticatedAccess: null,
  });
</script>

<QueryClientProvider client={queryClient}>
  <button type="button" onclick={() => (taskEvents += 1)}>Report an event</button>
  <RunActivity {task} {threadId} {taskEvents} />
</QueryClientProvider>
