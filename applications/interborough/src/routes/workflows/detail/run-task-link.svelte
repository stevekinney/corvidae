<script lang="ts">
  /**
   * A link from a run's page to its task (`/tasks/:id`), shown only when the Bureau answers
   * `bureau.tasks.get` for the run's identifier. The runs of the engine's own workflows are not the
   * Bureau's tasks, and a task the caller may not see answers as one that is not there, so the link
   * says nothing when there is no page to go to, and when the Bureau cannot say.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../../app/copy.ts';
  import { getTask } from '../../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';

  interface RunTaskLinkProps {
    runId: string;
  }

  let { runId }: RunTaskLinkProps = $props();

  const task = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.detail(runId),
      queryFn: ({ signal }) => getTask(runId, { signal }),
      retry: false,
    }),
    undefined,
  );

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(`/tasks/${encodeURIComponent(runId)}`);
  }
</script>

{#if task.data !== undefined}
  <a
    class="weft-workflow-detail__task-link"
    href={router.href(`/tasks/${encodeURIComponent(runId)}`)}
    onclick={open}>{TASK_COPY.viewTask}</a
  >
{/if}
