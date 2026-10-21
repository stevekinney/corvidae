<script lang="ts">
  /**
   * `/chat`: the caller's sessions across agents, newest update first, with load-more paging. The
   * rows are `ChatConversationList`'s, and opening one is `/chat/:sessionId`. The view frame has
   * already settled whether there is anything to list (`app/view-probes.ts`), so an empty list
   * never reaches this page, and New chat is here for the list that is not empty.
   */
  import { Button } from '@lostgradient/cinder';
  import { ChatConversationList } from '@lostgradient/chat';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { listAgents, listContexts } from '../../lib/bureau-client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { agentsByName, sessionSummary } from './session-summary.ts';

  const PAGE_SIZE = 20;

  const sessions = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.contexts.list(null),
      queryFn: ({ pageParam, signal }) =>
        listContexts({ limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      retry: false,
    }),
    undefined,
  );
  const agents = createQuery(
    () => ({ queryKey: queryKeys.agents.list(), queryFn: ({ signal }) => listAgents({ signal }) }),
    undefined,
  );

  const names = $derived(agentsByName(agents.data ?? []));
  const rows = $derived(
    combinePages(
      sessions.data?.pages,
      (page) => page.contexts,
      (context) => context.id,
    ).map((context) => sessionSummary(context, names)),
  );

  function openNewChat(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/chat/new');
  }
</script>

<section class="weft-chat-sessions" aria-labelledby="weft-chat-sessions-title">
  <header class="weft-chat-sessions__header">
    <h1 id="weft-chat-sessions-title" class="weft-chat-header__title">{CHAT_COPY.sessionsTitle}</h1>
    <Button href={router.href('/chat/new')} variant="primary" size="sm" onclick={openNewChat}>
      {CHAT_COPY.newChat}
    </Button>
  </header>

  <ChatConversationList
    conversations={rows}
    ariaLabel={CHAT_COPY.sessionsTitle}
    emptyText={CHAT_COPY.noSessions}
    hasMore={sessions.hasNextPage}
    loading={sessions.isFetchingNextPage}
    buttonLabel={CHAT_COPY.loadMore}
    onLoadMore={() => void sessions.fetchNextPage()}
    onSelectConversation={(id) => router.navigate(chatSessionPath(id))}
  />
</section>
