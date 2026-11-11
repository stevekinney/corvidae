<script lang="ts">
  /**
   * Related runs in the Details rail of a run the Bureau holds as a task and the workflow engine
   * does not: the other runs of the same chat, a few, each a link to its page with its status and
   * when it started. A chat with no other run says so. A run the engine holds has its own related
   * runs (`run-related.svelte`), the ones it started and the ones started alongside it.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY, TASK_COPY } from '../../../app/copy.ts';
  import { listAllTasks, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { rowTime } from '../../../lib/format/clock.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import StatusLabel from '../../../lib/status-label.svelte';
  import { taskStatusWord } from '../../../lib/status.ts';
  import { otherRunsOfChat } from './run-chat-related.ts';

  interface RunChatRelatedProps {
    /** The run the page shows, which is not listed among its own relatives. */
    runId: string;
    /** The chat's identifier: the tasks of that session are the related runs. */
    contextId: string;
    /** What each run is called: the chat's title, when the page has read it. */
    title?: string | undefined;
  }

  let { runId, contextId, title }: RunChatRelatedProps = $props();

  const tasks = createQuery(
    () => ({
      queryKey: ['bureau-tasks', 'related-chat', contextId] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => listAllTasks({ contextId }, { signal }),
      enabled: contextId !== '',
      retry: false,
    }),
    undefined,
  );
  const others = $derived(otherRunsOfChat(runId, tasks.data ?? []));

  /** Opens a link in place, leaving a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function pathOf(task: TaskView): string {
    return workflowDetailPath(task.id);
  }
</script>

{#if tasks.isSuccess}
  <section class="ib-run-related" aria-labelledby="ib-run-related-chat" data-section="related-chat">
    <h2 id="ib-run-related-chat" class="ib-run__heading-2">{RUN_DETAIL_COPY.related.heading}</h2>
    {#if others.length === 0}
      <p class="ib-run__note">{RUN_DETAIL_COPY.related.noneInChat}</p>
    {:else}
      <ul class="ib-run-related__list">
        {#each others as task (task.id)}
          {@const path = pathOf(task)}
          <li>
            <a href={router.href(path)} onclick={(event) => open(event, path)}
              >{title === undefined || title === '' ? TASK_COPY.runTitle : title}</a
            >{TASK_COPY.list.separator}<StatusLabel word={taskStatusWord(task.status)} />{TASK_COPY
              .list.separator}{rowTime(Date.parse(task.createdAt), Date.now())}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
