<script lang="ts">
  /**
   * `/agents/:id/memory`: what an agent remembers of the caller's chats, with a search, one
   * memory's lineage, and the two things a person can do to a memory: forget it and correct it.
   *
   * The Agents view's frame (`app/view-frame.svelte`) asks the Bureau first and owns the words for
   * loading, empty, failing, locked, and an agent that is not there, so this page renders only
   * once the agent has at least one memory. A blank search lists, newest first; a search ranks
   * every memory the agent has, because ranking has no score floor, so a search never answers
   * "nothing matched": an agent with no memory is the frame's empty state.
   */
  import { untrack } from 'svelte';

  import { Alert, Button, SearchField, Skeleton } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { listMemories, searchMemories, type Memory } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import MemoryChanges, { type ForgetOutcome } from './memory-changes.svelte';
  import MemoryDetail from './memory-detail.svelte';
  import { matchesQuery } from './memory-presentation.ts';
  import MemoryRow from './memory-row.svelte';

  const PAGE_SIZE = 20;
  /** The most memories a search ranks: the Bureau's own ceiling, so a match is rarely left out. */
  const SEARCH_LIMIT = 100;
  const agentId = untrack(() => router.current.params['id'] ?? '');

  /** What is typed, and what the last search applied. A blank applied search lists. */
  let typed = $state('');
  let applied = $state('');
  let selectedId = $state<string | null>(null);
  let notice = $state<'corrected' | undefined>(undefined);
  let outcome = $state<ForgetOutcome | undefined>(undefined);
  /** The memories a forget answered with a legal hold, which stays known when the receipt goes. */
  let held = $state<readonly string[]>([]);
  let forgetPending = $state(false);
  let changes = $state<ReturnType<typeof MemoryChanges> | undefined>(undefined);

  const list = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.memory.list(agentId),
      queryFn: ({ pageParam, signal }) =>
        listMemories(agentId, { limit: PAGE_SIZE, offset: pageParam }, { signal }),
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

  type Row = { readonly memory: Memory; readonly score: number | null };

  const active = $derived(applied === '' ? list : search);
  const rows = $derived.by<Row[]>(() => {
    if (applied === '') {
      return combinePages(
        list.data?.pages,
        (page) => page.memories,
        (memory) => memory.id,
      ).map((memory) => ({ memory, score: null }));
    }
    // The Bureau ranks every memory and has no floor, so its order is kept and its score is not a
    // verdict: a memory is a match when it holds a word of the query, as the marks show.
    return (search.data ?? [])
      .filter((hit) => matchesQuery(hit.memory.content, applied))
      .map((hit) => ({ memory: hit.memory, score: hit.score }));
  });

  function applySearch(event: SubmitEvent): void {
    event.preventDefault();
    applied = typed.trim();
  }

  function clearSearch(): void {
    typed = '';
    applied = '';
  }

  /**
   * A change landed. The lists were already read again by the change. The frame's probe is not
   * asked again: forgetting the agent's last memory would make it answer "empty" and replace this
   * page, taking the deletion's receipt off the screen before it could be read. The page says
   * there is nothing left, and the frame looks again the next time the page is opened.
   */
  function changed(change: {
    readonly kind: 'forgotten' | 'corrected';
    readonly id: string;
    readonly select?: boolean;
  }): void {
    if (change.kind === 'corrected') {
      notice = 'corrected';
      if (change.select !== false) selectedId = change.id;
    } else {
      notice = undefined;
      if (selectedId === change.id) selectedId = null;
    }
  }

  function open(id: string): void {
    notice = undefined;
    selectedId = id;
  }

  const backPath = agentPath(agentId);

  /** What the agent remembers, from the pages read so far. */
  const loaded = $derived(
    combinePages(
      list.data?.pages,
      (page) => page.memories,
      (memory) => memory.id,
    ).length,
  );

  /** The agent's memory count once every page of it has been read, and unknown before. */
  const total = $derived(list.hasNextPage || loaded === 0 ? undefined : loaded);

  /** Whether the search ranked as many memories as it can, so more may match than are shown. */
  const searchFilled = $derived((search.data?.length ?? 0) >= SEARCH_LIMIT);

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="weft-memory" aria-labelledby="weft-memory-title" data-agent={agentId}>
  <header class="weft-memory__header">
    <div>
      <h1 id="weft-memory-title" class="weft-chat-header__title">{MEMORY_COPY.heading}</h1>
      <p class="weft-chat-header__agent">
        <code class="weft-memory__agent">{agentId}</code>
        {#if loaded > 0}
          · <span data-testid="memory-count">{MEMORY_COPY.count(loaded, list.hasNextPage)}</span>
        {/if}
      </p>
    </div>
    <Button
      href={router.href(backPath)}
      variant="secondary"
      size="sm"
      onclick={(event) => goTo(event, backPath)}>{MEMORY_COPY.backToAgent(agentId)}</Button
    >
  </header>

  <form class="weft-memory__search" role="search" onsubmit={applySearch}>
    <SearchField
      id="weft-memory-search"
      aria-label={MEMORY_COPY.searchLabel}
      placeholder={MEMORY_COPY.searchPlaceholder}
      bind:value={typed}
      onClear={clearSearch}
    />
    <Button type="submit" variant="primary">{MEMORY_COPY.searchAction}</Button>
  </form>

  {#if notice === 'corrected'}
    <Alert variant="success" dismissible onDismiss={() => (notice = undefined)}>
      <p class="weft-memory__alert-title">{MEMORY_COPY.correct.saved.title}</p>
      <p class="weft-memory__alert-body">{MEMORY_COPY.correct.saved.description}</p>
    </Alert>
  {/if}

  <MemoryChanges
    bind:this={changes}
    {agentId}
    bind:outcome
    bind:held
    bind:forgetPending
    onChanged={changed}
  />

  <div class="weft-memory__body" data-has-detail={selectedId !== null}>
    <div class="weft-memory__results">
      {#if active.isPending}
        <div role="status" aria-busy="true" aria-label={MEMORY_COPY.loading}>
          <Skeleton height="1.5rem" width="50%" />
          <Skeleton height="6rem" />
        </div>
      {:else if active.isError}
        <Alert variant="danger">
          <p class="weft-memory__alert-title">{MEMORY_COPY.listFailed}</p>
          <Button variant="secondary" size="sm" onclick={() => void active.refetch()}
            >{RETRY_LABEL}</Button
          >
        </Alert>
      {:else}
        {#if applied !== ''}
          <p class="weft-memory__count" role="status" data-testid="memory-match-count">
            {#if rows.length > 0}
              {MEMORY_COPY.matchCount(rows.length, total, searchFilled)}
            {:else}
              {MEMORY_COPY.noMatch(applied)}
            {/if}
          </p>
        {/if}
        {#if rows.length === 0}
          {#if applied === ''}
            <p class="weft-memory__nothing" data-testid="memory-nothing-left">
              {MEMORY_COPY.nothingLeft}
            </p>
          {:else}
            <div>
              <Button variant="secondary" size="sm" onclick={clearSearch}
                >{MEMORY_COPY.clearMatch}</Button
              >
            </div>
          {/if}
        {/if}
        <ul class="weft-memory__list" aria-label={MEMORY_COPY.listLabel}>
          {#each rows as row (row.memory.id)}
            <MemoryRow
              memory={row.memory}
              query={applied}
              score={row.score}
              selected={row.memory.id === selectedId}
              {forgetPending}
              onOpen={open}
              onForget={(id) => changes?.askToForget(id)}
              onCorrect={(memory) => changes?.startCorrecting(memory)}
            />
          {/each}
        </ul>
        {#if applied === '' && list.hasNextPage}
          <Button
            variant="secondary"
            disabled={list.isFetchingNextPage}
            onclick={() => void list.fetchNextPage()}>{MEMORY_COPY.loadMore}</Button
          >
        {/if}
      {/if}
    </div>

    {#if selectedId !== null}
      {#key selectedId}
        <MemoryDetail
          {agentId}
          id={selectedId}
          legalHold={held.includes(selectedId)}
          {forgetPending}
          onOpen={open}
          onClose={() => (selectedId = null)}
          onForget={(id) => changes?.askToForget(id)}
          onCorrect={(memory) => changes?.startCorrecting(memory)}
        />
      {/key}
    {/if}
  </div>
</section>

<style>
  .weft-memory {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .weft-memory__header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cinder-space-2) var(--cinder-space-3);
  }

  .weft-memory__agent {
    font-family: var(--cinder-font-mono);
  }

  .weft-memory__search {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .weft-memory__search :global(.cinder-search-field) {
    flex: 1 1 16rem;
  }

  .weft-memory__body {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-4);
    align-items: start;
  }

  @media (min-width: 64rem) {
    .weft-memory__body[data-has-detail='true'] {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }

  .weft-memory__results {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .weft-memory__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-memory__count,
  .weft-memory__nothing {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-memory__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-memory__alert-body {
    margin: var(--cinder-space-1) 0 0;
  }
</style>
