<script lang="ts">
  /**
   * The tasks of one chat session (`bureau.tasks.list` with the session's `contextId`, a page of fifty at a time with Load more), reduced to one sentence about the chat's runs
   * that links to the run to open (`/runs/:id`). A run in the session is a task, so the list is read again when a
   * run ends. A session with no task, and a Bureau that cannot say, show nothing: the conversation
   * does not wait on this.
   */
  import { untrack } from 'svelte';

  import { createInfiniteQuery } from '@tanstack/svelte-query';

  import { listTasks } from '../../lib/bureau-tasks.ts';
  import { CHAT_COPY } from '../../app/copy.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';

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

  const runPath = (id: string): string => `/runs/${encodeURIComponent(id)}`;

  /** What the chat says of its runs, with the run to open; nothing when there is nothing to say. */
  const strip = $derived.by(() => {
    const needing = rows.filter((task) => task.status === 'input-required');
    const going = rows.filter((task) => task.status === 'working' || task.status === 'submitted');
    const failed = rows.filter((task) => task.status === 'failed');
    const first = rows[0];
    if (first === undefined) return undefined;
    if (needing[0] !== undefined) {
      return {
        text: CHAT_COPY.strip.waiting(needing.length),
        taskId: needing[0].id,
        tone: 'warning',
      };
    }
    if (going[0] !== undefined) {
      return { text: CHAT_COPY.strip.working(going.length), taskId: going[0].id, tone: 'info' };
    }
    if (rows.length === 1) {
      if (first.status === 'failed')
        return { text: CHAT_COPY.strip.failedOne, taskId: first.id, tone: 'danger' };
      if (first.status === 'canceled')
        return { text: CHAT_COPY.strip.canceledOne, taskId: first.id, tone: 'neutral' };
      return undefined;
    }
    if (failed[0] !== undefined) {
      return {
        text: CHAT_COPY.strip.failed(failed.length, rows.length),
        taskId: failed[0].id,
        tone: 'danger',
      };
    }
    return undefined;
  });

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if strip !== undefined}
  <p class="weft-chat-strip" data-tone={strip.tone}>
    <a
      class="weft-chat-tasks__link"
      href={router.href(runPath(strip.taskId))}
      onclick={(event) => open(event, runPath(strip.taskId))}>{strip.text}</a
    >
  </p>
{/if}
