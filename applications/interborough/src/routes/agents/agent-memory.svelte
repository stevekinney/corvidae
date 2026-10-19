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

  import { Alert, Badge, Button, SearchField, Skeleton } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { listMemories, searchMemories, type Memory } from '../../lib/memory-client.ts';
  import { agentMemoryViewInstance, queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import MemoryDetail from './memory-detail.svelte';
  import { formatMemoryTime, labelFor } from './memory-presentation.ts';

  const PAGE_SIZE = 20;
  const agentId = untrack(() => router.current.params['id'] ?? '');

  const queryClient = useQueryClient();

  /** What is typed, and what the last search applied. A blank applied search lists. */
  let typed = $state('');
  let applied = $state('');
  let selectedId = $state<string | null>(null);
  let notice = $state<'corrected' | undefined>(undefined);

  const list = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.memory.list(agentId),
      queryFn: ({ pageParam, signal }) =>
        listMemories(agentId, { limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      enabled: applied === '',
      retry: false,
    }),
    undefined,
  );

  const search = createQuery(
    () => ({
      queryKey: queryKeys.memory.search(agentId, applied),
      queryFn: ({ signal }) => searchMemories(agentId, applied, { limit: PAGE_SIZE }, { signal }),
      enabled: applied !== '',
      retry: false,
    }),
    undefined,
  );

  type Row = { readonly memory: Memory; readonly score: number | null };

  const active = $derived(applied === '' ? list : search);
  const rows = $derived.by<Row[]>(() => {
    if (applied === '') {
      return (list.data?.pages ?? [])
        .flatMap((page) => page.memories)
        .map((memory) => ({ memory, score: null }));
    }
    return (search.data ?? []).map((hit) => ({ memory: hit.memory, score: hit.score }));
  });

  function applySearch(event: SubmitEvent): void {
    event.preventDefault();
    applied = typed.trim();
  }

  function clearSearch(): void {
    typed = '';
    applied = '';
  }

  /** A change landed: the list is read again, and the frame looks again at whether anything is left. */
  function changed(change: {
    readonly kind: 'forgotten' | 'corrected';
    readonly id: string;
  }): void {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.view('agents', agentMemoryViewInstance(agentId)),
    });
    if (change.kind === 'corrected') {
      notice = 'corrected';
      selectedId = change.id;
    } else {
      notice = undefined;
    }
  }

  function open(id: string): void {
    notice = undefined;
    selectedId = id;
  }

  const backPath = agentPath(agentId);

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  /** A short excerpt of a memory, to name its Details action. */
  function excerpt(content: string): string {
    const text = content.trim().replace(/\s+/g, ' ');
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  }
</script>

<section class="weft-memory" aria-labelledby="weft-memory-title" data-agent={agentId}>
  <header class="weft-memory__header">
    <div>
      <h1 id="weft-memory-title" class="weft-chat-header__title">{MEMORY_COPY.heading}</h1>
      <p class="weft-chat-header__agent">{agentId}</p>
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
        <ul class="weft-memory__list" aria-label={MEMORY_COPY.listLabel}>
          {#each rows as row (row.memory.id)}
            <li
              class="weft-memory__row"
              data-memory={row.memory.id}
              data-selected={row.memory.id === selectedId}
            >
              <p class="weft-memory__content">{row.memory.content}</p>
              <div class="weft-memory__meta">
                <Badge variant="neutral" size="sm"
                  >{labelFor(MEMORY_COPY.memoryClass, row.memory.memoryClass)}</Badge
                >
                <time datetime={row.memory.createdAt}>{formatMemoryTime(row.memory.createdAt)}</time
                >
                {#if row.score !== null}
                  <span>{MEMORY_COPY.relevance}: {row.score.toFixed(2)}</span>
                {/if}
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`${MEMORY_COPY.openDetails}: ${excerpt(row.memory.content)}`}
                onclick={() => open(row.memory.id)}>{MEMORY_COPY.openDetails}</Button
              >
            </li>
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
          onOpen={open}
          onClose={() => (selectedId = null)}
          onChanged={changed}
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
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .weft-memory__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-memory__row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }

  .weft-memory__row[data-selected='true'] {
    border-color: var(--cinder-border-strong);
    outline: 2px solid var(--cinder-border-strong);
  }

  .weft-memory__content {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .weft-memory__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
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
