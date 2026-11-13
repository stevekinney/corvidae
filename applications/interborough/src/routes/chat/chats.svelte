<script lang="ts">
  /**
   * `/chats`, `/chats/:chat` and `/chats/new`: the chats the caller started as a list with the open
   * chat beside it (ListDetail). The list is the pane's own, header and all: "Chats" with a
   * secondary "+" icon button that starts a chat, a "Search chats" field and the status segments
   * (All, Waiting on you, Done, each with its count) under it, then the chats newest first under
   * their days, each day band naming the zone its times are in. A row is the chat's title and the
   * time it last changed on line one, and on line two its status (the one fixed column, so the
   * latest messages line up) and its latest message, or the question it asks while it waits on the
   * person. A pane dragged wide also names the agent before the message, as the list pattern does.
   *
   * The list owns its states, and the rest of the page stays live in each of them: first use is a
   * compact empty state with the one primary New chat, a search that matches nothing says what was
   * searched and offers Clear search, loading is skeleton rows in the rows' own shape (after 300
   * milliseconds, so a fast read never flickers), and a read that fails is an error inside the
   * list with its own Try again.
   *
   * The open chat is the address (`/chats/:chat`), not a query parameter, so a chat is a link that
   * can be shared and reloaded, and choosing a row navigates there. A chat the loaded pages lack is
   * read on its own and listed with the rest, and the open chat stays open when a search or a
   * segment leaves it out of the list. Pages load as the end of the list comes into view, or with
   * Load more; the search and the segments narrow the pages loaded. A chat the pending reviews name
   * is read on its own when its page is not loaded, so Waiting on you holds every waiting chat, and
   * a chat whose latest run failed says Failed (`recent-tasks.ts`, the same reading the
   * notification bell uses).
   */
  import { untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import {
    Button,
    DataList,
    EmptyState,
    ErrorState,
    ListDetail,
    LoadMore,
    SearchField,
    Segment,
    SegmentedControl,
    Skeleton,
    StackedListItem,
    StatusDot,
    Tooltip,
  } from '@lostgradient/cinder';
  import { MessageSquare, MessageSquarePlus, Plus } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { getContext, listAgents, listContexts } from '../../lib/bureau-client.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useMinuteClock } from '../home/home-clock.svelte.ts';
  import ChatPane from './index.svelte';
  import {
    CHAT_SEGMENTS,
    chatDayGroup,
    chatListRows,
    inSegment,
    matchingRows,
    pendingQuestions,
    segmentCounts,
    sessionRow,
    waitingChatIds,
    type ChatSegment,
    type SessionRow,
  } from './session-groups.ts';

  const PAGE_SIZE = 20;
  /** The width of the list pane, in pixels, from which it names the agent and today's date too. */
  const WIDE_PANE_WIDTH = 480;
  /** The header's width under which the status segments no longer fit on one line. */
  const SEGMENTS_MINIMUM_WIDTH = 236;

  // The outlet mounts a new route for each page, so the draft is named once. A new chat has no
  // session until its first run: the client names the thread now, and its row stands for it until
  // the Bureau lists it. Whether the address is the new chat's is read live: once the run has
  // started it is the chat's own, so a pane mounted from then on (the list narrowing to the pane
  // alone) reads the session instead of starting over.
  const draftId = untrack(() =>
    router.current.route?.pattern === '/chats/new' ? crypto.randomUUID() : null,
  );
  const isNew = $derived(router.current.route?.pattern === '/chats/new');
  /** The chat that is open: the address's, or the new chat's, which keeps its name once it starts. */
  const openId = $derived(router.current.params['chat'] ?? draftId);
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

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const clock = useMinuteClock();
  const zone = viewerTimeZone();
  const phone = new MediaQuery('(max-width: 639.98px)', false);

  const questions = $derived(pendingQuestions(reviews.data ?? []));
  const failedChats = $derived(chatsWithFailedRun(tasks.data?.tasks ?? []));
  /** Every chat the list holds, whatever the search and the segments leave. */
  const allRows = $derived(
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
    ),
  );
  const agentName = (row: SessionRow): string => agentLabel(row.agentName, catalog.data);

  // The pane's own width, which decides whether the day bands and line two name more.
  let paneWidth = $state(0);
  const wide = $derived(paneWidth >= WIDE_PANE_WIDTH);
  // The segments need room for their three labels on one line. In a pane dragged narrower than
  // that, as the long turn's frame draws it (row 21p), they give way to the search, and what was
  // chosen narrows nothing, like on a phone. An unmeasured pane shows them.
  const segmentsFit = $derived(paneWidth === 0 || paneWidth >= SEGMENTS_MINIMUM_WIDTH);

  // A phone's list is a screen of its own with no search or segments (row 06l), so what was typed
  // or chosen on a wider screen narrows nothing there, and comes back when the screen is wide again.
  let typed = $state('');
  let chosen = $state<ChatSegment>('all');
  const search = $derived(phone.current ? '' : typed);
  const segment = $derived<ChatSegment>(phone.current || !segmentsFit ? 'all' : chosen);
  const searched = $derived(matchingRows(allRows, search, agentName));
  // The segments count what the search leaves, so each says how many it would show.
  const counts = $derived(segmentCounts(searched));
  const visible = $derived(searched.filter((row) => inSegment(row, segment)));
  const searching = $derived(search.trim() !== '');

  // The open chat always has a row to open it in, so its pane is shown even when the Bureau has not
  // (yet) said anything about it, or a search leaves it out of the list: the pane reports a chat
  // that cannot be read in its own words.
  const items = $derived<SessionRow[]>(
    openId === null || visible.some((row) => row.id === openId)
      ? visible
      : [
          allRows.find((row) => row.id === openId) ?? {
            id: openId,
            title: CHAT_COPY.untitled,
            snippet: '',
            agentName: '',
            updatedAt: null,
            status: 'Done',
          },
          ...visible,
        ],
  );
  const listState = $derived.by<'loading' | 'failed' | 'first-use' | 'no-match' | 'none' | 'rows'>(
    () => {
      if (sessions.data === undefined) return sessions.isError ? 'failed' : 'loading';
      if (visible.length > 0) return 'rows';
      if (allRows.length === 0) return 'first-use';
      return searching ? 'no-match' : 'none';
    },
  );
  const noChats = $derived(sessions.data !== undefined && allRows.length === 0);

  function clearFilters(): void {
    typed = '';
    chosen = 'all';
  }

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

  /**
   * A row is a link, so it can be opened in another tab, and a plain click opens it without
   * leaving the application. Cinder's row draws the link itself, so the click is read where it
   * lands, and a modified click is left to the browser.
   */
  function follow(event: MouseEvent, openRow: (key: string) => void): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('a[href]') === null || target === null) return;
    const key = target.closest('[data-cinder-row-id]')?.getAttribute('data-cinder-row-id');
    if (key === null || key === undefined) return;
    event.preventDefault();
    openRow(key);
  }
</script>

{#snippet newChatButton()}
  <Tooltip text={CHAT_COPY.newChat}>
    <Button
      data-changes
      href={router.href('/chats/new')}
      variant="secondary"
      iconOnly
      size="sm"
      aria-label={CHAT_COPY.newChat}
      onclick={openNewChat}
    >
      <Plus aria-hidden="true" size={16} />
    </Button>
  </Tooltip>
{/snippet}

{#snippet loadMore()}
  {#if sessions.hasNextPage || sessions.isFetchingNextPage}
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

{#snippet rowsOfList(openRow: (key: string) => void)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="ib-chats__rows" onclick={(event) => follow(event, openRow)}>
    <DataList
      items={visible}
      key={(row: SessionRow) => row.id}
      aria-label={CHAT_COPY.sessionsTitle}
      groupBy={(row: SessionRow) => chatDayGroup(row, clock(), zone, wide, phone.current)}
    >
      {#snippet children(row: SessionRow)}
        {@const agent = agentName(row)}
        <StackedListItem
          data-cinder-row-id={row.id}
          data-chat={row.id}
          href={router.href(chatSessionPath(row.id))}
          selected={row.id === openId}
          statusPlacement="line-two"
          titleLines={phone.current ? 2 : 1}
          tooltip={row.title}
          metaTooltip={`${agent}, ${row.snippet}`}
        >
          {#snippet status()}<StatusDot word={row.status} />{/snippet}
          {#snippet title()}{row.title}{/snippet}
          {#snippet time()}
            {#if row.updatedAt !== null}
              <time datetime={new Date(row.updatedAt).toISOString()}>
                {clockTime(row.updatedAt, zone)}
              </time>
            {/if}
          {/snippet}
          {#snippet meta()}
            {#if wide}<span class="ib-chat-row__agent">{`${agent}, `}</span>{/if}{row.snippet}
          {/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
    {@render loadMore()}
  </div>
{/snippet}

{#snippet listBody(context: { open: (key: string) => void })}
  {#if listState === 'rows'}
    {@render rowsOfList(context.open)}
  {:else if listState === 'loading'}
    <Skeleton variant="list" rows={4} dayBand delay={300} label={CHAT_COPY.loadingSessions} />
  {:else if listState === 'failed'}
    <ErrorState
      size="compact"
      headingLevel={3}
      title={CHAT_COPY.list.failedTitle}
      description={CHAT_COPY.list.failedDescription}
      onRetry={() => void sessions.refetch()}
    />
  {:else if listState === 'first-use'}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={CHAT_COPY.list.emptyTitle}
      description={CHAT_COPY.list.emptyDescription}
    >
      {#snippet icon()}<MessageSquare aria-hidden="true" />{/snippet}
      {#snippet action()}
        <Button
          data-changes
          href={router.href('/chats/new')}
          variant="primary"
          size="sm"
          onclick={openNewChat}
        >
          {CHAT_COPY.newChat}
        </Button>
      {/snippet}
    </EmptyState>
  {:else if listState === 'no-match'}
    <EmptyState
      kind="not-found"
      size="compact"
      headingLevel={3}
      title={CHAT_COPY.list.noMatchTitle(search.trim())}
      description={CHAT_COPY.list.noMatchDescription}
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={clearFilters}>
          {CHAT_COPY.list.clearSearch}
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    {@const empty = CHAT_COPY.list.segmentEmpty[segment === 'done' ? 'done' : 'waiting']}
    <EmptyState
      kind="filtered"
      size="compact"
      headingLevel={3}
      title={empty.title}
      description={empty.description}
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={clearFilters}>
          {CHAT_COPY.list.showAll}
        </Button>
      {/snippet}
    </EmptyState>
  {/if}
  <!-- Chats not loaded yet may hold the one the search or the segment is for. -->
  {#if listState === 'no-match' || listState === 'none'}
    {@render loadMore()}
  {/if}
{/snippet}

<!-- On a phone the top bar's "‹ Chat" is the way back to the list (design rows 04y, 06m), so the pane
     draws no second Back of its own; between 640px and the width a pane stacks at, it still does. -->
<div class="ib-chats" data-shortcut-region="list-detail">
  <ListDetail
    {items}
    key={(row: SessionRow) => row.id}
    label={CHAT_COPY.sessionsTitle}
    detailLabel={CHAT_COPY.list.detailLabel}
    selectedKey={openId}
    onSelectedKeyChange={openChat}
    selectionParameter={null}
    storageKey="interborough-chats"
    listCollapsible
    collapseListLabel={CHAT_COPY.list.hideList}
    expandListLabel={CHAT_COPY.list.showList}
    flushDetail
    backVisible={!phone.current}
    {listBody}
  >
    {#snippet header()}
      <div class="ib-chats__controls" bind:clientWidth={paneWidth}>
        <div class="ib-chats__title-row">
          <svelte:element this={openId === null ? 'h1' : 'h2'} class="ib-chats__title">
            {phone.current ? CHAT_COPY.sessionsTitlePhone : CHAT_COPY.sessionsTitle}
          </svelte:element>
          {@render newChatButton()}
        </div>
        {#if !phone.current}
          <SearchField
            size="md"
            aria-label={CHAT_COPY.list.searchLabel}
            placeholder={CHAT_COPY.list.searchPlaceholder}
            bind:value={typed}
          />
          {#if segmentsFit}
            <SegmentedControl
              id="chat-status"
              label={CHAT_COPY.list.segmentsLabel}
              labelVisible={false}
              size="sm"
              value={segment}
              onValueChange={(next: ChatSegment) => (chosen = next)}
            >
              {#each CHAT_SEGMENTS as option (option)}
                <Segment
                  value={option}
                  count={sessions.data === undefined ? 'pending' : counts[option]}
                >
                  {CHAT_COPY.list.segments[option]}
                </Segment>
              {/each}
            </SegmentedControl>
          {/if}
        {/if}
      </div>
    {/snippet}
    {#snippet detail(row)}
      <ChatPane
        sessionId={row.id}
        {isNew}
        agent={row.agentName === '' ? undefined : agentName(row)}
      />
    {/snippet}
    {#snippet empty()}
      {#if noChats}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title={CHAT_COPY.list.noChatTitle}
          description={CHAT_COPY.list.noChatDescription}
        >
          {#snippet icon()}<MessageSquarePlus size={28} aria-hidden="true" />{/snippet}
        </EmptyState>
      {:else}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title={listState === 'failed' ? CHAT_COPY.list.noChatTitle : CHAT_COPY.list.pickTitle}
          description={listState === 'failed'
            ? CHAT_COPY.list.noChatDescription
            : CHAT_COPY.list.pickDescription}
        >
          {#snippet icon()}<MessageSquarePlus size={28} aria-hidden="true" />{/snippet}
          {#snippet action()}
            <Button
              data-changes
              href={router.href('/chats/new')}
              variant="primary"
              size="sm"
              onclick={openNewChat}
            >
              {CHAT_COPY.newChat}
            </Button>
          {/snippet}
        </EmptyState>
      {/if}
    {/snippet}
  </ListDetail>
</div>
