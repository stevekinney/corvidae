<script lang="ts">
  /**
   * `/agents/:agent/memories`: what an agent remembers of the caller's chats, as a list with the
   * open memory beside it (Cinder's `ListDetail`, the same layout as Chats and Reviews). The list's
   * header holds the title, Export, a search that runs as you type, and a kind filter in plain
   * names. A memory opens beside the list with Correct and Forget on its context line and the
   * governance actions below it (`memory-detail.svelte`).
   *
   * The Agents view's frame (`app/view-frame.svelte`) asks the server first and owns the words for
   * loading, empty, failing, locked, and an agent that is not there, so this page renders only once
   * the agent has at least one memory. A blank search lists, newest first; a search ranks every
   * memory the agent has, because ranking has no score floor, so a search never answers "nothing
   * matched" from the server: the page counts the memories that hold a word of the query. The kind
   * filter works over the pages read so far, and says so while there are more.
   */
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import {
    Alert,
    Button,
    EmptyState,
    ListDetail,
    SearchField,
    Select,
    Skeleton,
  } from '@lostgradient/cinder';
  import { Download } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import {
    listMemories,
    MEMORY_PAGE_SIZE,
    searchMemories,
    type Memory,
  } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import MemoryChanges, { type ForgetOutcome } from './memory-changes.svelte';
  import MemoryDetail from './memory-detail.svelte';
  import MemoryGovernance from './memory-governance.svelte';
  import { matchesKind, matchesQuery, type KindFilter } from './memory-presentation.ts';
  import MemoryRow from './memory-row.svelte';

  /** The most memories a search ranks: the server's own ceiling, so a match is rarely left out. */
  const SEARCH_LIMIT = 100;
  const agentId = untrack(() => router.current.params['agent'] ?? '');
  const selectionLocation = routerSelectionLocationFor(untrack(() => router.pathname));

  /** What is typed: a search runs as it changes, and a blank one lists. */
  let typed = $state('');
  const applied = $derived(typed.trim());
  let kindFilter = $state<KindFilter>('all');
  let selectedId = $state<string | null>(null);
  let notice = $state<'corrected' | undefined>(undefined);
  let outcome = $state<ForgetOutcome | undefined>(undefined);
  /** What is known of each memory's legal hold, which stays known when a receipt goes. */
  const holds = new SvelteMap<string, 'held' | 'free'>();
  let forgetPending = $state(false);
  let governancePending = $state(false);
  let changes = $state<ReturnType<typeof MemoryChanges> | undefined>(undefined);
  let governance = $state<ReturnType<typeof MemoryGovernance> | undefined>(undefined);

  const listing = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.memory.list(agentId),
      queryFn: ({ pageParam, signal }) =>
        listMemories(agentId, { limit: MEMORY_PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      // Kept current while a search is applied: the header's count and the match total read it.
      retry: false,
    }),
    undefined,
  );

  const search = createQuery(
    () => ({
      queryKey: queryKeys.memory.search(agentId, applied),
      queryFn: ({ signal }) =>
        searchMemories(agentId, applied, { limit: SEARCH_LIMIT }, { signal }),
      enabled: applied !== '',
      retry: false,
    }),
    undefined,
  );

  type MemoryRowData = {
    readonly kind: 'memory';
    readonly id: string;
    readonly memory: Memory | undefined;
    readonly score: number | null;
  };
  type MoreRowData = { readonly kind: 'more'; readonly id: string };
  type ListRow = MemoryRowData | MoreRowData;

  /** The key of the row that loads the next page, which is a row so J and K reach it. */
  const MORE_KEY = '__load-more__';

  const active = $derived(applied === '' ? listing : search);
  /** Every memory the list or the search holds, before the kind filter. */
  const base = $derived.by<MemoryRowData[]>(() => {
    if (applied === '') {
      return combinePages(
        listing.data?.pages,
        (page) => page.memories,
        (memory) => memory.id,
      ).map((memory) => ({ kind: 'memory', id: memory.id, memory, score: null }));
    }
    // The server ranks every memory and has no floor, so its order is kept and its score is not a
    // verdict: a memory is a match when it holds a word of the query, as the marks show.
    return (search.data ?? [])
      .filter((hit) => matchesQuery(hit.memory.content, applied))
      .map((hit) => ({ kind: 'memory', id: hit.memory.id, memory: hit.memory, score: hit.score }));
  });
  const shown = $derived(
    kindFilter === 'all'
      ? base
      : base.filter((row) => row.memory !== undefined && matchesKind(row.memory, kindFilter)),
  );
  /**
   * The open memory when the list does not hold it: one a correction replaced, one the address
   * names, or one the search or the kind filter hides. It leads the list so it stays visible.
   */
  const pinned = $derived.by<MemoryRowData[]>(() => {
    if (selectedId === null || shown.some((row) => row.id === selectedId)) return [];
    const known = base.find((row) => row.id === selectedId);
    return [{ kind: 'memory', id: selectedId, memory: known?.memory, score: null }];
  });
  const items = $derived<ListRow[]>([
    ...pinned,
    ...shown,
    ...(applied === '' && listing.hasNextPage ? [{ kind: 'more' as const, id: MORE_KEY }] : []),
  ]);

  /** What the agent remembers, from the pages read so far. */
  const loaded = $derived(
    combinePages(
      listing.data?.pages,
      (page) => page.memories,
      (memory) => memory.id,
    ).length,
  );

  /** The agent's memory count once every page of it has been read, and unknown before. */
  const total = $derived(listing.hasNextPage || loaded === 0 ? undefined : loaded);

  /** Whether the search ranked as many memories as it can, so more may match than are shown. */
  const searchFilled = $derived((search.data?.length ?? 0) >= SEARCH_LIMIT);

  const kindOptions = [
    { value: 'all', label: MEMORY_COPY.filter.all },
    { value: 'facts', label: MEMORY_COPY.filter.facts },
    { value: 'chats', label: MEMORY_COPY.filter.chats },
    { value: 'howTo', label: MEMORY_COPY.filter.howTo },
    { value: 'you', label: MEMORY_COPY.filter.you },
  ] satisfies { value: KindFilter; label: string }[];

  /** The filter a select value names; anything else shows every kind. */
  function filterNamed(value: string): KindFilter {
    return kindOptions.find((option) => option.value === value)?.value ?? 'all';
  }

  function clearAll(): void {
    typed = '';
    kindFilter = 'all';
  }

  /** A memory is gone from the list: close its details, and drop the note about the last change. */
  function gone(id: string): void {
    notice = undefined;
    if (selectedId === id) selectedId = null;
  }

  /** A correction landed: say so, and follow the person to it unless they moved on meanwhile. */
  function corrected(replaced: string, correction: Memory): void {
    notice = 'corrected';
    if (selectedId === replaced) selectedId = correction.id;
  }

  function open(id: string): void {
    notice = undefined;
    selectedId = id;
  }
</script>

<div class="ib-memory" data-agent={agentId}>
  {#if notice === 'corrected'}
    <Alert variant="success" dismissible onDismiss={() => (notice = undefined)}>
      <p class="ib-memory__alert-title">{MEMORY_COPY.correct.saved.title}</p>
      <p class="ib-memory__alert-body">{MEMORY_COPY.correct.saved.description}</p>
    </Alert>
  {/if}

  <MemoryChanges
    bind:this={changes}
    {agentId}
    bind:outcome
    {holds}
    bind:forgetPending
    onForgotten={gone}
  />
  <MemoryGovernance
    bind:this={governance}
    {agentId}
    {holds}
    bind:pending={governancePending}
    onQuarantined={gone}
  />

  <div class="ib-memory__frame" data-shortcut-region="list-detail">
    <ListDetail
      {items}
      key={(row: ListRow) => row.id}
      label={MEMORY_COPY.listLabel}
      detailLabel={MEMORY_COPY.detail.heading}
      backLabel={MEMORY_COPY.backToList}
      emptyTitle={MEMORY_COPY.nothingOpen.title}
      emptyDescription={MEMORY_COPY.nothingOpen.description}
      bind:selectedKey={selectedId}
      selectionParameter="memory"
      {selectionLocation}
      storageKey="interborough-memory"
    >
      {#snippet header()}
        <div class="ib-memory__title-row">
          <h1 class="ib-memory__title">{MEMORY_COPY.heading}</h1>
          <Button
            data-changes
            variant="secondary"
            size="sm"
            disabled={governancePending}
            onclick={() => governance?.exportAll()}
          >
            {#snippet leadingIcon()}<Download aria-hidden="true" size={14} />{/snippet}
            {MEMORY_COPY.govern.export.action}
          </Button>
        </div>
        <SearchField
          id="ib-memory-search"
          aria-label={MEMORY_COPY.searchLabel}
          placeholder={MEMORY_COPY.searchPlaceholder}
          bind:value={typed}
          onClear={() => (typed = '')}
        />
        <Select
          id="ib-memory-kind"
          label={MEMORY_COPY.filter.label}
          labelVisible={false}
          size="sm"
          options={kindOptions}
          value={kindFilter}
          onchange={(event) => (kindFilter = filterNamed(event.currentTarget.value))}
        />
        {#if loaded > 0}
          <p class="ib-memory__count" data-testid="memory-count">
            {MEMORY_COPY.count(loaded, listing.hasNextPage)}
          </p>
        {/if}
        {#if applied !== '' && base.length > 0}
          <p class="ib-memory__count" role="status" data-testid="memory-match-count">
            {MEMORY_COPY.matchCount(base.length, total, searchFilled)}
          </p>
        {/if}
        {#if kindFilter !== 'all' && base.length > 0}
          <p class="ib-memory__count" data-testid="memory-kind-note">
            {MEMORY_COPY.filter.note(
              shown.length,
              base.length,
              applied === '' && listing.hasNextPage,
            )}
          </p>
        {/if}
      {/snippet}
      {#snippet list(row, context)}
        {#if row.kind === 'more'}
          <div class="ib-memory__more">
            <Button
              variant="secondary"
              size="sm"
              disabled={listing.isFetchingNextPage}
              onclick={() => void listing.fetchNextPage()}>{MEMORY_COPY.loadMore}</Button
            >
          </div>
        {:else}
          <MemoryRow
            {agentId}
            id={row.id}
            memory={row.memory}
            query={applied}
            score={row.score}
            selected={context.selected}
            onOpen={context.open}
          />
        {/if}
      {/snippet}
      {#snippet listEmpty()}
        {#if active.isPending}
          <div role="status" aria-busy="true" aria-label={MEMORY_COPY.loading}>
            <Skeleton height="1.5rem" width="50%" />
            <Skeleton height="6rem" />
          </div>
        {:else if active.isError}
          <Alert variant="danger">
            <p class="ib-memory__alert-title">{MEMORY_COPY.listFailed}</p>
            <Button variant="secondary" size="sm" onclick={() => void active.refetch()}
              >{RETRY_LABEL}</Button
            >
          </Alert>
        {:else if applied !== ''}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={2}
            title={MEMORY_COPY.noMatch.title(applied)}
            description={MEMORY_COPY.noMatch.description}
            clearFiltersLabel={MEMORY_COPY.clearMatch}
            onClearFilters={clearAll}
          />
        {:else if kindFilter !== 'all'}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={2}
            title={MEMORY_COPY.noKind.title}
            description={MEMORY_COPY.noKind.description}
            clearFiltersLabel={MEMORY_COPY.clearMatch}
            onClearFilters={clearAll}
          />
        {:else}
          <EmptyState
            kind="done"
            size="compact"
            headingLevel={2}
            title={MEMORY_COPY.nothingLeft.title}
            description={MEMORY_COPY.nothingLeft.description}
          />
        {/if}
      {/snippet}
      {#snippet detail(row)}
        {#key row.id}
          <MemoryDetail
            {agentId}
            id={row.id}
            hold={holds.get(row.id)}
            {forgetPending}
            {governancePending}
            onOpen={open}
            onForget={(memory) => changes?.askToForget(memory)}
            onCorrected={corrected}
            onShare={(memory) => governance?.askToShare(memory)}
            onHold={(id, change) => governance?.changeHold(id, change)}
            onQuarantine={(memory) => governance?.askToQuarantine(memory)}
          />
        {/key}
      {/snippet}
    </ListDetail>
  </div>
</div>

<style>
  .ib-memory {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  /* ListDetail fills the height it is given and scrolls each pane, so the frame gives it one. */
  .ib-memory__frame {
    block-size: max(28rem, calc(100dvh - 8rem));
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-memory__title-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    align-items: center;
    justify-content: space-between;
  }

  .ib-memory__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-memory__count {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-memory__more {
    display: flex;
    justify-content: center;
    padding: var(--cinder-space-2);
  }

  .ib-memory__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-memory__alert-body {
    margin: var(--cinder-space-1) 0 0;
  }
</style>
