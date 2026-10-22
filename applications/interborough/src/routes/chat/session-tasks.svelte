<script lang="ts">
  /**
   * The tasks of one chat session (`bureau.tasks.list` with the session's `contextId`, a page of fifty at a time with Load more), each linking
   * to its page at `/tasks/:id`. A run in the session is a task, so the list is read again when a
   * run ends. A session with no task, and a Bureau that cannot say, show nothing: the conversation
   * does not wait on this.
   */
  import { untrack } from 'svelte';

  import { Badge, Button } from '@lostgradient/cinder';
  import { createInfiniteQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { listTasks } from '../../lib/bureau-tasks.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { taskStatePresentation } from '../tasks/task-presentation.ts';

  interface SessionTasksProps {
    sessionId: string;
    /** Whether a run is going, so the list is read again when it stops. */
    streaming: boolean;
  }

  let { sessionId, streaming }: SessionTasksProps = $props();

  const PAGE_SIZE = 50;

  const tasks = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.ofSession(sessionId),
      queryFn: ({ pageParam, signal }) =>
        listTasks(
          {
            contextId: sessionId,
            limit: PAGE_SIZE,
            ...(pageParam === '' ? {} : { pageToken: pageParam }),
          },
          { signal },
        ),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextPageToken ?? undefined,
      retry: false,
    }),
    undefined,
  );
  // Each page after the first reads the listing as the first page saw it, so a task appears once;
  // the pages are still joined by id, as every paged list here is.
  const rows = $derived(
    combinePages(
      tasks.data?.pages,
      (page) => page.tasks,
      (task) => task.id,
    ),
  );

  let wasStreaming = untrack(() => streaming);
  $effect(() => {
    const now = streaming;
    // Only the end of a run asks again. Reading the query here would make each answer ask again.
    if (wasStreaming && !now) untrack(() => void tasks.refetch());
    wasStreaming = now;
  });

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if rows.length > 0}
  <section class="weft-chat-tasks" aria-labelledby="weft-chat-tasks-title">
    <h2 id="weft-chat-tasks-title" class="weft-chat-tasks__title">{CHAT_COPY.tasksTitle}</h2>
    <ul class="weft-chat-tasks__list">
      {#each rows as task (task.id)}
        {@const presentation = taskStatePresentation(task.status)}
        <li class="weft-chat-tasks__item">
          <a
            class="weft-chat-tasks__link"
            href={router.href(`/tasks/${encodeURIComponent(task.id)}`)}
            onclick={(event) => open(event, `/tasks/${encodeURIComponent(task.id)}`)}
            ><code title={task.id}>{truncateId(task.id)}</code></a
          >
          <Badge variant={presentation.variant} size="sm">{presentation.label}</Badge>
        </li>
      {/each}
    </ul>
    {#if tasks.hasNextPage}
      <Button
        variant="secondary"
        size="sm"
        label={CHAT_COPY.loadMore}
        loading={tasks.isFetchingNextPage}
        onclick={() => void tasks.fetchNextPage()}
      />
    {/if}
  </section>
{/if}
