<script lang="ts">
  /**
   * The Chats tab of an agent's page (board PageAgent, rows 38e to 38g and 39p): the chats held with
   * that agent under one filter row, the state segments with their counts (All, Waiting on you,
   * Running), a search of their titles, Started by (you, a schedule, a goal) and Sort by, all in
   * Cinder's `FilterBar` (sweep S33). Every filter goes to the Bureau, which applies it before it
   * cuts a page, so a page holds matching chats and "Load more" reaches the rest of them. Changing a
   * filter reads the first page again under its own query key, so pages read under one filter never
   * merge with another's. While a read has nothing to show yet, or failed with nothing to show, the
   * list's place says so and the filters stay (`agent-tab-state.svelte`).
   *
   * The rows are the Hooks page's shape: a status word in the one fixed column, so titles start at
   * one position, the chat's title and the time it last changed, and its latest message on line two
   * (the question it asks while it waits on you), under day bands that name the zone the times are
   * in. The page's board puts the status first, so the rows do not use the chat list's line-two
   * status. When the agent has no chat and no filter is on, the tab is an empty state with the one
   * primary New chat, and reports it (`empty`) so the header demotes its own New chat.
   */
  import {
    Button,
    DataList,
    EmptyState,
    FilterBar,
    StackedListItem,
    StatusDot,
    type FacetDefinition,
    type FilterSegment,
  } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { listContexts } from '../../lib/bureau-client.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    chatDayGroup,
    pendingQuestions,
    sessionRow,
    type SessionRow,
  } from '../chat/session-groups.ts';
  import { useMinuteClock } from '../home/home-clock.svelte.ts';
  import {
    CHAT_ORIGINS,
    CHAT_SORTS,
    CHAT_STATES,
    chatListRequest,
    DEFAULT_CHAT_FILTERS,
    sortOf,
    startedByOf,
    stateOf,
    type ChatCounts,
    type ChatFilters,
  } from './agent-chat-filters.ts';
  import { newChatPath } from './agent-presentation.ts';
  import AgentTabState from './agent-tab-state.svelte';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The agent's name as a person reads it, which the empty state says. */
    name: string;
    /**
     * How many of the agent's chats are in each state, for the counts the segments carry, or
     * `undefined` while they are not known. They are the chats a person started (the header's own
     * count), whatever the filters say.
     */
    counts: ChatCounts | undefined;
    /** Whether the tab is its empty state: the agent has no chat and no filter is on. */
    empty?: boolean;
    /** The agent's plugin is disabled: the empty state offers no New chat and says what to enable. */
    unavailable?: boolean;
    /** The disabled plugin's title, which the empty state names. */
    pluginTitle?: string;
  }

  let {
    id,
    name,
    counts,
    empty = $bindable(false),
    unavailable = false,
    pluginTitle = '',
  }: Props = $props();

  const copy = AGENT_PAGE_COPY.chats;
  const PAGE_SIZE = 20;

  let filters = $state<ChatFilters>({ ...DEFAULT_CHAT_FILTERS });
  /** What is typed in the search field; the trimmed text is the filter. */
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
  // What each waiting chat asks, and which chats' latest run failed: the same reads the chat list
  // makes. A chat falls back to its last message while they load or when the Bureau cannot say.
  const reviews = createQuery(
    () => ({
      queryKey: queryKeys.bureauReviews.list(),
      queryFn: ({ signal }) => listBureauReviews({ signal }),
      retry: false,
    }),
    undefined,
  );
  const tasks = createQuery(() => ({ ...recentTasksQuery(), retry: false }), undefined);

  const clock = useMinuteClock();
  const zone = viewerTimeZone();

  const contexts = $derived(
    combinePages(
      sessions.data?.pages,
      (page) => page.contexts,
      (context) => context.id,
    ),
  );
  const questions = $derived(pendingQuestions(reviews.data ?? []));
  const failedChats = $derived(chatsWithFailedRun(tasks.data?.tasks ?? []));
  /**
   * The rows in the order the Bureau cut them, which is the order the person picked. A row's time
   * is the one the order is by (when it last changed, or when it was started), so the day bands,
   * which group consecutive rows, never repeat a day.
   */
  const rows = $derived(
    contexts.map((context): SessionRow => {
      const stamp = Date.parse(filters.sort === 'updated' ? context.updatedAt : context.createdAt);
      return {
        ...sessionRow(context, questions, failedChats),
        updatedAt: Number.isNaN(stamp) ? null : stamp,
      };
    }),
  );
  const filtered = $derived(
    filters.state !== 'all' || filters.startedBy !== 'any' || filters.title !== '',
  );
  const isEmpty = $derived(sessions.data !== undefined && rows.length === 0 && !filtered);
  $effect(() => {
    empty = isEmpty;
  });

  function clearFilters(): void {
    typed = '';
    filters = { ...DEFAULT_CHAT_FILTERS, sort: filters.sort };
  }

  const segments = $derived<FilterSegment[]>(
    CHAT_STATES.map((value) => ({
      value,
      label: copy.states[value],
      count: counts === undefined ? 'pending' : counts[value],
    })),
  );
  const facets: FacetDefinition[] = [
    {
      type: 'select',
      key: 'startedBy',
      label: copy.startedByLabel,
      placeholder: copy.startedByAnyone,
      options: CHAT_ORIGINS.map((value) => ({ value, label: copy.startedBy[value] })),
    },
    {
      type: 'select',
      key: 'sort',
      label: copy.sortLabel,
      placeholder: copy.sortDefault,
      options: CHAT_SORTS.map((value) => ({ value, label: copy.sorts[value] })),
    },
  ];
  const appliedFilters = $derived([
    ...(filters.startedBy === 'any'
      ? []
      : [{ key: 'startedBy', value: filters.startedBy, label: copy.startedByLabel }]),
    ...(filters.sort === 'updated'
      ? []
      : [{ key: 'sort', value: filters.sort, label: copy.sortLabel }]),
  ]);

  function changeFacet(key: string, value: string): void {
    if (key === 'startedBy') filters = { ...filters, startedBy: startedByOf(value) };
    else if (key === 'sort') filters = { ...filters, sort: sortOf(value) };
  }
</script>

<div class="ib-agent-chats" data-testid="agent-chats">
  {#if !isEmpty}
    <FilterBar
      aria-label={copy.filtersLabel}
      {segments}
      segmentValue={filters.state}
      segmentsLabel={copy.stateLabel}
      searchQuery={typed}
      searchPlaceholder={copy.searchPlaceholder}
      searchAriaLabel={copy.searchLabel}
      {facets}
      {appliedFilters}
      onSegmentChange={(value) => (filters = { ...filters, state: stateOf(value) })}
      onSearchChange={(query) => {
        typed = query;
        filters = { ...filters, title: query.trim() };
      }}
      onFacetChange={changeFacet}
      onFilterRemove={(key) => changeFacet(key, '')}
    />
  {/if}

  <AgentTabState
    tab={AGENT_PAGE_COPY.tabs.chats}
    shape="rows"
    pending={sessions.isPending}
    error={sessions.error}
    updatedAt={sessions.dataUpdatedAt}
    onRetry={() => void sessions.refetch()}
  >
    {#if sessions.data !== undefined && rows.length === 0}
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
          description={unavailable
            ? copy.unavailableDescription(pluginTitle)
            : copy.emptyDescription(name)}
        >
          {#snippet action()}
            {#if !unavailable}
              <Button
                href={router.href(newChatPath(id))}
                variant="primary"
                size="sm"
                onclick={(event) => {
                  event.preventDefault();
                  router.navigate(newChatPath(id));
                }}>{CHAT_COPY.newChat}</Button
              >
            {/if}
          {/snippet}
        </EmptyState>
      {/if}
    {:else if rows.length > 0}
      <div {@attach followLinks}>
        <DataList
          items={rows}
          key={(row: SessionRow) => row.id}
          statusColumn
          aria-label={CHAT_COPY.agentSessions}
          groupBy={(row: SessionRow) => chatDayGroup(row, clock(), zone, true)}
        >
          {#snippet children(row: SessionRow)}
            <StackedListItem
              href={router.href(chatSessionPath(row.id))}
              tooltip={row.title}
              metaTooltip={row.snippet}
              wrapMeta
              data-chat={row.id}
            >
              {#snippet status()}<StatusDot word={row.status} size="sm" />{/snippet}
              {#snippet title()}{row.title}{/snippet}
              {#snippet time()}
                {#if row.updatedAt !== null}
                  <time datetime={new Date(row.updatedAt).toISOString()}>
                    {clockTime(row.updatedAt, zone)}
                  </time>
                {/if}
              {/snippet}
              {#snippet meta()}<span class="ib-agent-chats__line">{row.snippet}</span>{/snippet}
            </StackedListItem>
          {/snippet}
        </DataList>
      </div>
      {#if sessions.hasNextPage}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={sessions.isFetchingNextPage}
            onclick={() => void sessions.fetchNextPage()}>{CHAT_COPY.loadMore}</Button
          >
        </div>
      {/if}
    {/if}
  </AgentTabState>
</div>

<style>
  /* A long preview ends at the second line with an ellipsis; an unbroken value wraps anywhere. */
  .ib-agent-chats__line {
    display: -webkit-box;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
</style>
