<script lang="ts">
  /**
   * The Tasks view: `/tasks`, the caller's tasks, and `/tasks/:id`, one of them. One component
   * dispatches on the address, as the Workflows area does. The view frame has already asked the
   * Bureau whether there is a task to list, or whether this one exists and may be seen.
   */
  import { untrack } from 'svelte';

  import { router } from '../../lib/router.svelte.ts';
  import TaskDetail from './task-detail.svelte';
  import TaskList from './task-list.svelte';

  // The outlet mounts a new page when the path changes, so the task is read once.
  const taskId = untrack(() => router.current.params['id']);
</script>

{#if taskId === undefined}
  <TaskList />
{:else}
  <TaskDetail {taskId} />
{/if}
