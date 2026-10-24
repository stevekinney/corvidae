<script lang="ts">
  /**
   * `/chat`: the chats the caller started, one flat row each, under the headings "Needs you" (the
   * chats whose run waits on the person, whatever their age), Today, Yesterday and Earlier. A row is
   * the agent's avatar, the chat's title, its latest message (or, while it waits on the person, the
   * question it asks), when it last changed, and a chip only while it needs the person. Opening
   * one is `/chat/:sessionId`. The view frame has already settled whether there is anything to list
   * (`app/view-probes.ts`), so an empty list never reaches this page, and New chat is here for the
   * list that is not empty. Pages load as the end comes into view, or with Load more. A chat the
   * pending reviews name is read on its own when its page is not loaded, so "Needs you" holds every
   * waiting chat, and a chat whose latest run failed carries a Failed chip (`recent-tasks.ts`, the
   * same reading the notification bell uses).
   */
  import { Avatar, Badge, Button, LoadMore, RelativeTime, Skeleton } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { getContext, listContexts } from '../../lib/bureau-client.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { taskStatePresentation } from '../../lib/task-status.ts';
  import {
    agentAvatarName,
    agentTone,
    groupSessions,
    pendingQuestions,
    sessionRow,
    waitingChatIds,
  } from './session-groups.ts';

  const PAGE_SIZE = 20;

  const sessions = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.contexts.list(null),
      queryFn: ({ pageParam, signal }) =>
        listContexts({ origin: 'chat', limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      retry: false,
    }),
    undefined,
  );
  // What each waiting chat asks. The row falls back to the chat's last message while this loads or
  // when the Bureau cannot say, so a failed read never hides a chat.
  const reviews = createQuery(
    () => ({
      queryKey: queryKeys.bureauReviews.list(),
      queryFn: ({ signal }) => listBureauReviews({ signal }),
      retry: false,
    }),
    undefined,
  );

  // The latest run of each chat, for the Failed chip. A Bureau that cannot say shows no chip.
  const tasks = createQuery(() => ({ ...recentTasksQuery(), retry: false }), undefined);

  const loaded = $derived(
    combinePages(
      sessions.data?.pages,
      (page) => page.contexts,
      (context) => context.id,
    ),
  );
  // The list is newest first and a page holds twenty, so a chat that waits on the person can be
  // on a page that is not loaded. The reviews name it, and it is read on its own.
  const missingWaiting = $derived.by(() => {
    if (sessions.data === undefined) return [];
    const have = new Set(loaded.map((context) => context.id));
    return waitingChatIds(reviews.data ?? []).filter((id) => !have.has(id));
  });
  const waiting = createQuery(
    () => ({
      queryKey: queryKeys.contexts.waiting(missingWaiting),
      queryFn: async ({ signal }) => {
        const answers = await Promise.allSettled(
          missingWaiting.map((id) => getContext(id, { signal })),
        );
        // A review's chat may be a goal's or a schedule's session, which Chat does not list; one the
        // Bureau cannot read is left out rather than hiding the others.
        return answers.flatMap((answer) =>
          answer.status === 'fulfilled' && answer.value.origin === 'chat' ? [answer.value] : [],
        );
      },
      enabled: missingWaiting.length > 0,
      retry: false,
    }),
    undefined,
  );

  const questions = $derived(pendingQuestions(reviews.data ?? []));
  const failedChats = $derived(chatsWithFailedRun(tasks.data?.tasks ?? []));
  const groups = $derived(
    groupSessions(
      combinePages(
        [loaded, missingWaiting.length > 0 ? (waiting.data ?? []) : []],
        (contexts) => contexts,
        (context) => context.id,
      ).map((context) => sessionRow(context, questions, failedChats)),
      Date.now(),
    ),
  );
  const needsYou = taskStatePresentation('input-required');
  const failedState = taskStatePresentation('failed');

  function openNewChat(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/chat/new');
  }

  function openChat(event: MouseEvent, id: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(chatSessionPath(id));
  }
</script>

<section class="ib-chats" aria-labelledby="ib-chats-title">
  <header class="ib-chats__header">
    <h1 id="ib-chats-title" class="weft-chat-header__title">{CHAT_COPY.sessionsTitle}</h1>
    <Button href={router.href('/chat/new')} variant="primary" size="sm" onclick={openNewChat}>
      {CHAT_COPY.newChat}
    </Button>
  </header>

  <nav class="ib-chats__groups" aria-label={CHAT_COPY.sessionsTitle}>
    {#each groups as group (group.key)}
      <section class="ib-chat-group" data-group={group.key} aria-labelledby="ib-chats-{group.key}">
        <h2 id="ib-chats-{group.key}" class="ib-chat-group__title">{group.label}</h2>
        <ul class="ib-chat-group__rows">
          {#each group.rows as row (row.id)}
            <li class="ib-chat-row" data-session={row.id}>
              <a
                class="ib-chat-row__link"
                href={router.href(chatSessionPath(row.id))}
                onclick={(event) => openChat(event, row.id)}
              >
                <Avatar
                  class="ib-chat-avatar"
                  size="sm"
                  name={agentAvatarName(row.agentName)}
                  alt={row.agentName}
                  data-tone={agentTone(row.agentName)}
                />
                <span class="ib-chat-row__title">{row.title}</span>
                <span class="ib-chat-row__snippet">{row.snippet}</span>
                {#if row.needsYou}
                  <Badge variant={needsYou.variant} size="sm" class="ib-chat-row__chip"
                    >{needsYou.label}</Badge
                  >
                {:else if row.failed}
                  <Badge variant={failedState.variant} size="sm" class="ib-chat-row__chip"
                    >{failedState.label}</Badge
                  >
                {/if}
                {#if row.updatedAt !== null}
                  <RelativeTime class="ib-chat-row__time" date={row.updatedAt} />
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    {#if sessions.isPending}
      <Skeleton height="2rem" />
    {/if}
    <LoadMore
      hasMore={sessions.hasNextPage}
      loading={sessions.isFetchingNextPage}
      onLoadMore={async () => {
        await sessions.fetchNextPage();
      }}
      buttonLabel={CHAT_COPY.loadMore}
      endOfListMessage=""
    />
  </nav>
</section>
