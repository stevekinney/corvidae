<script lang="ts">
  /**
   * The Chats tab of an agent's page: the chats held with that agent, cut by what they are doing
   * now (all, needs you, running), by who started them (you, a schedule, a goal), by a search of
   * their titles, and in the order the person picks. Every filter goes to the Bureau, which applies
   * it before it cuts a page, so a page holds matching chats and "Load more" reaches the rest of
   * them. Changing a filter reads the first page again under its own query key, so pages read under
   * one filter never merge with another's.
   */
  import {
    Alert,
    Button,
    EmptyState,
    Segment,
    SegmentedControl,
    SearchField,
    Select,
    StatusDot,
  } from '@lostgradient/cinder';
  import { createInfiniteQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, CHAT_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { listContexts } from '../../lib/bureau-client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    chatListRequest,
    DEFAULT_CHAT_FILTERS,
    type ChatFilters,
    type ChatSort,
    type ChatStartedBy,
    type ChatState,
  } from './agent-chat-filters.ts';
  import { newChatPath } from './agent-presentation.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
  }

  let { id }: Props = $props();

  const copy = AGENT_PAGE_COPY.chats;
  const PAGE_SIZE = 20;

  let filters = $state<ChatFilters>({ ...DEFAULT_CHAT_FILTERS });
  /** What is typed in the search field; it becomes the filter on Enter or clear. */
  let typed = $state('');

  const sessions = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.contexts.filtered(id, { ...filters }),
      queryFn: ({ pageParam, signal }) =>
        listContexts(
          { agentName: id, ...chatListRequest(filters), limit: PAGE_SIZE, offset: pageParam },
          { signal },
        ),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      retry: false,
    }),
    undefined,
  );

  const rows = $derived(
    combinePages(
      sessions.data?.pages,
      (page) => page.contexts,
      (context) => context.id,
    ),
  );
  const filtered = $derived(
    filters.state !== 'all' || filters.startedBy !== 'any' || filters.title !== '',
  );

  function clearFilters(): void {
    typed = '';
    filters = { ...DEFAULT_CHAT_FILTERS, sort: filters.sort };
  }

  const startedByOptions = (Object.keys(copy.startedBy) as ChatStartedBy[]).map((value) => ({
    value,
    label: copy.startedBy[value],
  }));
  const sortOptions = (Object.keys(copy.sorts) as ChatSort[]).map((value) => ({
    value,
    label: copy.sorts[value],
  }));
</script>

<div class="ib-agent-chats" data-testid="agent-chats">
  <div class="ib-agent-chats__controls">
    <SegmentedControl
      id="ib-agent-chat-state"
      label={copy.stateLabel}
      labelVisible={false}
      size="sm"
      value={filters.state}
      onValueChange={(state: ChatState) => (filters = { ...filters, state })}
    >
      <Segment value="all">{copy.states.all}</Segment>
      <Segment value="needs-you">{copy.states['needs-you']}</Segment>
      <Segment value="running">{copy.states.running}</Segment>
    </SegmentedControl>
    <!-- Enter submits the form, which every browser does; only some fire a search event. -->
    <form
      class="ib-agent-chats__search"
      role="search"
      onsubmit={(event) => {
        event.preventDefault();
        filters = { ...filters, title: typed.trim() };
      }}
    >
      <SearchField
        id="ib-agent-chat-search"
        aria-label={copy.searchLabel}
        placeholder={copy.searchPlaceholder}
        size="sm"
        bind:value={typed}
        onClear={() => (filters = { ...filters, title: '' })}
      />
    </form>
    <Select
      id="ib-agent-chat-started-by"
      label={copy.startedByLabel}
      value={filters.startedBy}
      options={startedByOptions}
      onchange={(event) =>
        (filters = { ...filters, startedBy: event.currentTarget.value as ChatStartedBy })}
    />
    <Select
      id="ib-agent-chat-sort"
      label={copy.sortLabel}
      value={filters.sort}
      options={sortOptions}
      onchange={(event) => (filters = { ...filters, sort: event.currentTarget.value as ChatSort })}
    />
  </div>

  {#if sessions.isError}
    <Alert variant="danger">
      <p>{copy.loadFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void sessions.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if sessions.isSuccess && rows.length === 0}
    {#if filtered}
      <EmptyState
        kind="filtered"
        size="compact"
        headingLevel={3}
        title={copy.filteredTitle}
        description={copy.filteredDescription}
        onClearFilters={clearFilters}
        clearFiltersLabel={copy.clearFilters}
      />
    {:else}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={3}
        title={copy.emptyTitle}
        description={copy.emptyDescription}
      >
        {#snippet action()}
          <Button
            href={router.href(newChatPath(id))}
            variant="primary"
            size="sm"
            onclick={(event) => {
              event.preventDefault();
              router.navigate(newChatPath(id));
            }}>{CHAT_COPY.newChat}</Button
          >
        {/snippet}
      </EmptyState>
    {/if}
  {:else if rows.length > 0}
    <!-- The rows stay in the order the Bureau cut them, which is the order the person picked. -->
    <nav aria-label={CHAT_COPY.agentSessions}>
      <ul class="ib-agent-chat-list">
        {#each rows as chat (chat.id)}
          <li>
            <button
              type="button"
              class="ib-agent-chat"
              onclick={() => router.navigate(chatSessionPath(chat.id))}
            >
              <span class="ib-agent-chat__title">{chat.title ?? CHAT_COPY.untitled}</span>
              {#if chat.lastMessagePreview}
                <span class="ib-agent-chat__preview">{chat.lastMessagePreview}</span>
              {/if}
              <span class="ib-agent-chat__meta">
                {#if chat.activity === 'running' || chat.activity === 'awaiting-input'}
                  <StatusDot
                    size="sm"
                    status={chat.activity === 'running' ? 'accent' : 'warning'}
                    label={chat.activity === 'running'
                      ? copy.states.running
                      : copy.states['needs-you']}
                  />
                {/if}
                <time datetime={chat.updatedAt}
                  >{formatRelativeTime(Date.parse(chat.updatedAt))}</time
                >
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if sessions.hasNextPage}
        <Button
          variant="secondary"
          size="sm"
          disabled={sessions.isFetchingNextPage}
          onclick={() => void sessions.fetchNextPage()}>{CHAT_COPY.loadMore}</Button
        >
      {/if}
    </nav>
  {/if}
</div>
