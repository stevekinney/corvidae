<script lang="ts">
  /**
   * `/chats`, `/chats/:chat` and `/chats/new`: the chats the caller started as a list with the open
   * chat beside it (ListDetail). The list puts the chats whose run waits on the person first,
   * whatever their age, then the rest newest first. A row is the agent's avatar, the chat's title,
   * its latest message (or, while it waits on the person, the question it asks), when it last
   * changed, and a chip only while it needs the person or its latest run failed.
   *
   * The open chat is the address (`/chats/:chat`), not a query parameter, so a chat is a link that
   * can be shared and reloaded, and choosing a row navigates there. A chat the loaded pages lack is
   * read on its own and listed with the rest, and a new chat is a row of its own until its first
   * run starts and the Bureau lists it. The view frame has already settled whether there is
   * anything to list (`app/view-probes.ts`), so an empty list never reaches this page. Pages load
   * as the end of the list comes into view, or with Load more. A chat the pending reviews name is
   * read on its own when its page is not loaded, so "Needs you" holds every waiting chat, and a
   * chat whose latest run failed carries a Failed chip (`recent-tasks.ts`, the same reading the
   * notification bell uses).
   */
  import { untrack } from 'svelte';

  import {
    Avatar,
    Badge,
    Button,
    EmptyState,
    ListDetail,
    LoadMore,
    RelativeTime,
    SelectableRow,
    Skeleton,
  } from '@lostgradient/cinder';
  import { MessageSquarePlus } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { getContext, listContexts } from '../../lib/bureau-client.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { DEFAULT_AGENT } from '../../lib/default-agent.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { taskStatePresentation } from '../../lib/task-status.ts';
  import ChatPane from './index.svelte';
  import {
    agentAvatarName,
    agentTone,
    chatListRows,
    pendingQuestions,
    sessionRow,
    waitingChatIds,
    type ChatListRow,
  } from './session-groups.ts';

  const PAGE_SIZE = 20;

  // The outlet mounts a new route for each path, so these are read once. A new chat has no session
  // until its first run: the client names the thread now, and its row stands for it until the
  // Bureau lists it.
  const isNew = untrack(() => router.current.route?.pattern === '/chats/new');
  const draftId = untrack(() => (isNew ? crypto.randomUUID() : null));
  /** The chat that is open: the address's, or the new chat's, which keeps its name once it starts. */
  const openId = $derived(router.current.params['chat'] ?? draftId);
  const draftAgent = $derived(router.current.search.get('agent') ?? DEFAULT_AGENT);

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

  // The open chat, when it is on no loaded page (a link to an old chat), is listed with the rest. It
  // is read under a key of its own, apart from the pane's read of the same session: two readers of
  // one entry that are given different options ask for it over and over. Its options read no other
  // query's result either, so it asks once, whether the chat is on a loaded page or not.
  const openIsListed = $derived(
    openId === null ||
      loaded.some((context) => context.id === openId) ||
      (waiting.data ?? []).some((context) => context.id === openId),
  );
  const open = createQuery(
    () => ({
      queryKey: queryKeys.contexts.row(openId ?? ''),
      queryFn: ({ signal }) => getContext(openId ?? '', { signal }),
      enabled: openId !== null && openId !== draftId,
      retry: false,
    }),
    undefined,
  );

  const questions = $derived(pendingQuestions(reviews.data ?? []));
  const failedChats = $derived(chatsWithFailedRun(tasks.data?.tasks ?? []));
  const rows = $derived(
    chatListRows(
      combinePages(
        [
          loaded,
          missingWaiting.length > 0 ? (waiting.data ?? []) : [],
          open.data !== undefined && !openIsListed ? [open.data] : [],
        ],
        (contexts) => contexts,
        (context) => context.id,
      ).map((context) => sessionRow(context, questions, failedChats)),
      Date.now(),
      // The new chat's row leads the list until the Bureau lists the chat itself.
      draftId === null
        ? undefined
        : { id: draftId, title: CHAT_COPY.untitled, snippet: draftAgent, agentName: draftAgent },
    ),
  );
  // The open chat always has a row, so its pane is shown even when the Bureau has not (yet) said
  // anything about it: the pane reports a chat that cannot be read in its own words.
  const shown = $derived<ChatListRow[]>(
    openId === null || rows.some((row) => row.id === openId)
      ? rows
      : [
          {
            id: openId,
            title: CHAT_COPY.untitled,
            snippet: '',
            agentName: '',
            updatedAt: null,
            needsYou: false,
            failed: false,
            group: 'earlier',
          },
          ...rows,
        ],
  );
  const lastId = $derived(shown.at(-1)?.id);
  const needsYou = taskStatePresentation('input-required');
  const failedState = taskStatePresentation('failed');

  function openNewChat(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/chats/new');
  }

  /** Opens the chosen row's chat, or the list alone when Back clears the choice. */
  function openChat(key: string | null): void {
    if (key === openId) return;
    router.navigate(key === null ? '/chats' : chatSessionPath(key));
  }
</script>

<div class="ib-chats" data-shortcut-region="list-detail">
  <ListDetail
    items={shown}
    key={(row: ChatListRow) => row.id}
    label={CHAT_COPY.sessionsTitle}
    detailLabel={CHAT_COPY.list.detailLabel}
    selectedKey={openId}
    onSelectedKeyChange={openChat}
    selectionParameter={null}
    storageKey="interborough-chats"
  >
    {#snippet header()}
      <div class="ib-chats__title-row">
        <svelte:element this={openId === null ? 'h1' : 'h2'} class="ib-chats__title">
          {CHAT_COPY.sessionsTitle}
        </svelte:element>
        <Button href={router.href('/chats/new')} variant="primary" size="sm" onclick={openNewChat}>
          {CHAT_COPY.newChat}
        </Button>
      </div>
    {/snippet}
    {#snippet list(row, context)}
      <SelectableRow
        selected={context.selected}
        selectedState="current"
        onclick={context.open}
        data-chat={row.id}
        data-group={row.group}
      >
        {#snippet leading()}
          <Avatar
            class="ib-chat-avatar"
            size="sm"
            name={agentAvatarName(row.agentName)}
            alt={row.agentName}
            data-tone={agentTone(row.agentName)}
          />
        {/snippet}
        {#snippet title()}<span class="ib-chat-row__title">{row.title}</span>{/snippet}
        {#snippet description()}<span class="ib-chat-row__snippet">{row.snippet}</span>{/snippet}
        {#snippet meta()}
          {#if row.needsYou}
            <Badge variant={needsYou.variant} size="sm">{needsYou.label}</Badge>
          {:else if row.failed}
            <Badge variant={failedState.variant} size="sm">{failedState.label}</Badge>
          {/if}
          {#if row.updatedAt !== null}
            <RelativeTime date={row.updatedAt} />
          {/if}
        {/snippet}
      </SelectableRow>
      {#if row.id === lastId}
        <LoadMore
          hasMore={sessions.hasNextPage}
          loading={sessions.isFetchingNextPage}
          onLoadMore={async () => {
            await sessions.fetchNextPage();
          }}
          buttonLabel={CHAT_COPY.loadMore}
          endOfListMessage=""
        />
      {/if}
    {/snippet}
    {#snippet listEmpty()}
      {#if sessions.isPending}
        <Skeleton height="2rem" />
      {:else}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={CHAT_COPY.list.emptyTitle}
          description={CHAT_COPY.list.emptyDescription}
        />
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        kind="first-use"
        headingLevel={2}
        title={CHAT_COPY.list.pickTitle}
        description={CHAT_COPY.list.pickDescription}
      >
        {#snippet icon()}<MessageSquarePlus size={28} aria-hidden="true" />{/snippet}
        {#snippet action()}
          <Button
            href={router.href('/chats/new')}
            variant="primary"
            size="sm"
            onclick={openNewChat}
          >
            {CHAT_COPY.newChat}
          </Button>
        {/snippet}
      </EmptyState>
    {/snippet}
    {#snippet detail(row)}
      <ChatPane sessionId={row.id} {isNew} />
    {/snippet}
  </ListDetail>
</div>
