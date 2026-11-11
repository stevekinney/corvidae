<script lang="ts">
  /**
   * The Memory tab of an agent's page (`/agents/:agent/memory`): what the agent remembers of the
   * caller's chats, as a list with the open memory beside it (Cinder's `ListDetail`, the same layout
   * as Chats and Reviews), under the agent's header and tab bar. The open memory is in the address
   * (`?selected=`), so it can be linked and reloaded; choosing one replaces the address in place
   * (the tab stays mounted, with what was typed). The list's header holds Add a memory
   * (`memory-add.svelte`) as a "+", a search that runs as you type, the two filters ("Kind: All" and
   * "Written by: Anyone") and Export, which is hidden until there is something to export; the tab's
   * name is the tab bar's, so the list repeats no heading of its own. A memory opens beside the
   * list with Correct and Forget on its context line, its label/value rows and the governance
   * actions under "More options" (`memory-detail.svelte`). Forgetting a memory opens the one after
   * it, or the one before when it was the last.
   *
   * While the first page of the list is read, or when that read fails, the tab says so in its body
   * (`agent-tab-state.svelte`), and the header and the tabs stay. An agent with no memory is not one
   * of those: the tab says so itself, because it is where the first memory is added. A blank search
   * lists, newest first; a search ranks every memory the agent has, because ranking has no score
   * floor, so a search never answers "nothing matched" from the server: the page counts the
   * memories that hold a word of the query. The filters work over the pages read so far, and say so
   * while there are more.
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
  import { Download, Plus } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { agentMemoryPath } from '../../lib/agent-paths.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import {
    listMemories,
    MEMORY_PAGE_SIZE,
    searchMemories,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import MemoryAdd from './memory-add.svelte';
  import MemoryChanges, { type ForgetOutcome } from './memory-changes.svelte';
  import MemoryDetail from './memory-detail.svelte';
  import MemoryGovernance from './memory-governance.svelte';
  import {
    matchesKind,
    matchesQuery,
    matchesWriter,
    refusalWords,
    type KindFilter,
    type WriterFilter,
  } from './memory-presentation.ts';
  import AgentTabState from './agent-tab-state.svelte';
  import MemoryRow from './memory-row.svelte';

  /** The most memories a search ranks: the server's own ceiling, so a match is rarely left out. */
  const SEARCH_LIMIT = 100;
  const agentId = untrack(() => router.current.params['agent'] ?? '');

  /** What is typed: a search runs as it changes, and a blank one lists. */
  let typed = $state('');
  const applied = $derived(typed.trim());
  let kindFilter = $state<KindFilter>('all');
  let writerFilter = $state<WriterFilter>('all');
  /** The open memory: the one the address names, so a link and a reload open it. */
  const selectedId = $derived(router.search.get('selected'));
  /** What the last change said above the list: only a correction that landed. */
  let notice = $state<'corrected' | undefined>(undefined);
  /** A correction that was refused, with the text that was sent, until it is dismissed or retried. */
  let refused = $state<
    { readonly id: string; readonly fault: MemoryFault; readonly content: string } | undefined
  >(undefined);
  /** The text of a refused correction the person chose to edit again, for the memory it is for. */
  let resume = $state<{ readonly id: string; readonly content: string } | undefined>(undefined);
  let outcome = $state<ForgetOutcome | undefined>(undefined);
  /** What is known of each memory's legal hold, which stays known when a receipt goes. */
  const holds = new SvelteMap<string, 'held' | 'free'>();
  let forgetPending = $state(false);
  let governancePending = $state(false);
  let changes = $state<ReturnType<typeof MemoryChanges> | undefined>(undefined);
  let governance = $state<ReturnType<typeof MemoryGovernance> | undefined>(undefined);
  let adding = $state<ReturnType<typeof MemoryAdd> | undefined>(undefined);
  let exporting = $state(false);

  // What the agent is called where the page names it: "From Tool runner", "Tool runner reads this".
  const agents = createQuery(agentsListQuery);
  const agentName = $derived(agentLabel(agentId, agents.data));

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
    /** The open memory the list does not hold: it leads the list without being one of its results. */
    readonly pinned: boolean;
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
      ).map((memory) => ({ kind: 'memory', id: memory.id, memory, score: null, pinned: false }));
    }
    // The server ranks every memory and has no floor, so its order is kept and its score is not a
    // verdict: a memory is a match when it holds a word of the query, as the marks show.
    return (search.data ?? [])
      .filter((hit) => matchesQuery(hit.memory.content, applied))
      .map((hit) => ({
        kind: 'memory',
        id: hit.memory.id,
        memory: hit.memory,
        score: hit.score,
        pinned: false,
      }));
  });
  /** Whether a filter narrows the list, which works over the pages read so far. */
  const filtered = $derived(kindFilter !== 'all' || writerFilter !== 'all');
  const shown = $derived(
    filtered
      ? base.filter(
          (row) =>
            row.memory !== undefined &&
            matchesKind(row.memory, kindFilter) &&
            matchesWriter(row.memory, writerFilter),
        )
      : base,
  );
  /**
   * The open memory when the list does not hold it: one a correction replaced, one the address
   * names, or one the search or the kind filter hides. It leads the list so it stays visible.
   */
  const pinned = $derived.by<MemoryRowData[]>(() => {
    if (selectedId === null || shown.some((row) => row.id === selectedId)) return [];
    const known = base.find((row) => row.id === selectedId);
    return [{ kind: 'memory', id: selectedId, memory: known?.memory, score: null, pinned: true }];
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

  /**
   * Whether the agent has no memory at all, which the tab says itself: its Add a memory is then the
   * one place to add, and there is nothing to export.
   */
  const firstUse = $derived(listing.data !== undefined && loaded === 0 && !listing.hasNextPage);

  const kindOptions = [
    { value: 'all', label: MEMORY_COPY.filter.kind.all },
    { value: 'fact', label: MEMORY_COPY.filter.kind.fact },
    { value: 'how-to', label: MEMORY_COPY.filter.kind.howTo },
  ] satisfies { value: KindFilter; label: string }[];
  const writerOptions = $derived<{ value: WriterFilter; label: string }[]>([
    { value: 'all', label: MEMORY_COPY.filter.writer.all },
    { value: 'you', label: MEMORY_COPY.filter.writer.you },
    { value: 'agent', label: MEMORY_COPY.filter.writer.agent(agentName) },
  ]);

  /** The kind a select value names; anything else shows every kind. */
  function kindNamed(value: string): KindFilter {
    return kindOptions.find((option) => option.value === value)?.value ?? 'all';
  }

  /** The writer a select value names; anything else shows every writer. */
  function writerNamed(value: string): WriterFilter {
    return writerOptions.find((option) => option.value === value)?.value ?? 'all';
  }

  function clearAll(): void {
    typed = '';
    kindFilter = 'all';
    writerFilter = 'all';
  }

  /**
   * A memory is gone from the list: drop the note about the last change, and when it was the open
   * one, open the memory after it (the one before when it was the last), or close the details when
   * the list has no other.
   */
  function gone(id: string): void {
    notice = undefined;
    if (selectedId !== id) return;
    const at = shown.findIndex((row) => row.id === id);
    const next = at === -1 ? undefined : (shown[at + 1] ?? shown[at - 1]);
    select(next?.id ?? null);
  }

  /** A correction landed: say so, and follow the person to it unless they moved on meanwhile. */
  function corrected(replaced: string, correction: Memory): void {
    notice = 'corrected';
    if (refused?.id === replaced) refused = undefined;
    resume = undefined;
    if (selectedId === replaced) select(correction.id);
  }

  /**
   * A memory was added: open it, which keeps it in view whatever the list is narrowed to. The
   * toast that says so, with its Undo, is the dialog's (`memory-add.svelte`).
   */
  function added(memory: Memory): void {
    notice = undefined;
    resume = undefined;
    select(memory.id);
  }

  /** A correction was refused: say so here, because the panel that asked is gone once the person moves on. */
  function correctionFailed(id: string, fault: MemoryFault, content: string): void {
    notice = undefined;
    refused = { id, fault, content };
  }

  /** Opens the memory a refused correction was for, with the refused text back in its form. */
  function editAgain(failure: { readonly id: string; readonly content: string }): void {
    notice = undefined;
    resume = { id: failure.id, content: failure.content };
    select(failure.id);
    refused = undefined;
  }

  function open(id: string | null): void {
    notice = undefined;
    resume = undefined;
    select(id);
  }

  /**
   * Opens a memory, or the list alone for `null`, in the address. It replaces the entry and keeps
   * the tab mounted: the address names what the tab already shows, so what was typed stays typed.
   */
  function select(id: string | null): void {
    if (id === selectedId) return;
    router.navigate(agentMemoryPath(agentId, id ?? undefined), { replace: true, keep: true });
  }
</script>

<!-- The first read of the list decides whether the tab has anything to show. A failure after that,
     or a search's, is said above the list, which keeps what it shows. -->
<AgentTabState
  tab={AGENT_PAGE_COPY.tabs.memory}
  shape="rows"
  pending={listing.isPending}
  error={listing.data === undefined ? listing.error : null}
  updatedAt={listing.dataUpdatedAt}
  onRetry={() => void listing.refetch()}
>
  <div class="ib-memory" data-agent={agentId}>
    {#if notice !== undefined}
      <Alert variant="success" dismissible onDismiss={() => (notice = undefined)}>
        <p class="ib-memory__alert-title">{MEMORY_COPY.correct.saved.title}</p>
        <p class="ib-memory__alert-body">{MEMORY_COPY.correct.saved.description}</p>
      </Alert>
    {/if}

    {#if refused !== undefined}
      {@const failure = refused}
      {@const words = refusalWords(refused.fault)}
      <Alert variant="danger" dismissible onDismiss={() => (refused = undefined)}>
        <p class="ib-memory__alert-title" data-correction-refusal={refused.fault.kind}>
          {MEMORY_COPY.correct.notSaved.title}
        </p>
        <p class="ib-memory__alert-body">{words.title}</p>
        {#if words.description !== ''}
          <p class="ib-memory__alert-body">{words.description}</p>
        {/if}
        <p class="ib-memory__alert-body">{MEMORY_COPY.correct.notSaved.draftLabel}</p>
        <blockquote class="ib-memory__draft" data-correction-draft>{refused.content}</blockquote>
        {#if selectedId !== refused.id}
          <Button variant="secondary" size="sm" onclick={() => editAgain(failure)}
            >{MEMORY_COPY.correct.notSaved.editAgain}</Button
          >
        {/if}
      </Alert>
    {/if}

    {#if active.isError && (applied !== '' || listing.data !== undefined)}
      <Alert variant="danger">
        <p class="ib-memory__alert-title">{MEMORY_COPY.listFailed}</p>
        <Button variant="secondary" size="sm" onclick={() => void active.refetch()}
          >{RETRY_LABEL}</Button
        >
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
      bind:exporting
      onQuarantined={gone}
    />
    <MemoryAdd bind:this={adding} {agentId} {agentName} onAdded={added} onUndone={gone} />

    <!-- A filter that hides the search hits is not "no match": the hits are there. -->
    {#snippet emptiness()}
      {#if active.isPending}
        <div role="status" aria-busy="true" aria-label={MEMORY_COPY.loading}>
          <Skeleton height="1.5rem" width="50%" />
          <Skeleton height="6rem" />
        </div>
      {:else if active.isError}
        <!-- The fault is reported above the list, so this is not read as an empty agent. -->
      {:else if filtered && (applied === '' || base.length > 0)}
        <EmptyState
          kind="filtered"
          size="compact"
          headingLevel={2}
          title={MEMORY_COPY.noFiltered.title}
          description={MEMORY_COPY.noFiltered.description}
          clearFiltersLabel={MEMORY_COPY.clearMatch}
          onClearFilters={clearAll}
        />
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
      {:else}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={2}
          title={MEMORY_COPY.nothing.title}
          description={MEMORY_COPY.nothing.description}
        >
          {#snippet action()}
            <Button data-changes variant="primary" size="sm" onclick={() => adding?.ask()}
              >{MEMORY_COPY.add.action}</Button
            >
          {/snippet}
        </EmptyState>
      {/if}
    {/snippet}

    <div class="ib-memory__frame" data-shortcut-region="list-detail">
      <ListDetail
        {items}
        key={(row: ListRow) => row.id}
        label={MEMORY_COPY.listLabel}
        detailLabel={MEMORY_COPY.detail.heading}
        backLabel={MEMORY_COPY.backToList}
        emptyTitle={MEMORY_COPY.nothingOpen.title}
        emptyDescription={MEMORY_COPY.nothingOpen.description}
        selectedKey={selectedId}
        onSelectedKeyChange={open}
        selectionParameter={null}
        storageKey="interborough-memory"
      >
        {#snippet header()}
          <div class="ib-memory__search-row">
            <div class="ib-memory__search">
              <SearchField
                id="ib-memory-search"
                aria-label={MEMORY_COPY.searchLabel}
                placeholder={MEMORY_COPY.searchPlaceholder}
                bind:value={typed}
                onClear={() => (typed = '')}
              />
            </div>
            {#if !firstUse}
              <Button
                data-changes
                variant="secondary"
                size="sm"
                iconOnly
                title={MEMORY_COPY.add.action}
                aria-label={MEMORY_COPY.add.action}
                onclick={() => adding?.ask()}
              >
                <Plus aria-hidden="true" size={16} />
              </Button>
            {/if}
          </div>
          <div class="ib-memory__filters">
            <Select
              id="ib-memory-kind"
              aria-label={MEMORY_COPY.filter.kindLabel}
              size="sm"
              options={kindOptions}
              value={kindFilter}
              onchange={(event) => (kindFilter = kindNamed(event.currentTarget.value))}
            />
            <Select
              id="ib-memory-writer"
              aria-label={MEMORY_COPY.filter.writerLabel}
              size="sm"
              options={writerOptions}
              value={writerFilter}
              onchange={(event) => (writerFilter = writerNamed(event.currentTarget.value))}
            />
          </div>
          {#if loaded > 0}
            <div>
              <Button
                data-changes
                variant="ghost"
                size="sm"
                disabled={governancePending}
                onclick={() => governance?.exportAll()}
              >
                {#snippet leadingIcon()}<Download aria-hidden="true" size={14} />{/snippet}
                {exporting ? MEMORY_COPY.govern.export.exporting : MEMORY_COPY.govern.export.action}
              </Button>
            </div>
          {/if}
          {#if pinned.length > 0 && shown.length === 0}
            <div data-testid="memory-pinned-status">{@render emptiness()}</div>
          {/if}
          {#if applied !== '' && base.length > 0}
            <p class="ib-memory__count" role="status" data-testid="memory-match-count">
              {MEMORY_COPY.matchCount(base.length, total, searchFilled)}
            </p>
          {/if}
          {#if filtered && base.length > 0}
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
              {agentName}
              id={row.id}
              memory={row.memory}
              query={applied}
              score={row.score}
              pinned={row.pinned}
              selected={context.selected}
              onOpen={context.open}
            />
          {/if}
        {/snippet}
        {#snippet listEmpty()}
          {@render emptiness()}
        {/snippet}
        {#snippet detail(row)}
          {#key row.id}
            <MemoryDetail
              {agentId}
              {agentName}
              id={row.id}
              hold={holds.get(row.id)}
              {forgetPending}
              {governancePending}
              onOpen={open}
              onForget={(memory) => changes?.askToForget(memory)}
              onCorrected={corrected}
              onCorrectionFailed={correctionFailed}
              resume={resume?.id === row.id ? resume.content : undefined}
              onShare={(memory) => governance?.askToShare(memory)}
              onHold={(id, change) => governance?.changeHold(id, change)}
              onQuarantine={(memory) => governance?.askToQuarantine(memory)}
            />
          {/key}
        {/snippet}
      </ListDetail>
    </div>
  </div>
</AgentTabState>

<style>
  .ib-memory {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  /* ListDetail fills the height it is given and scrolls each pane, so the frame gives it one: what
     the window leaves under the agent's header and tab bar. */
  .ib-memory__frame {
    block-size: max(28rem, calc(100dvh - 18rem));
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  /* The search takes the row, with the "+" that adds a memory at its end. */
  .ib-memory__search-row {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  .ib-memory__search {
    flex: 1;
    min-inline-size: 0;
  }

  /* The two selects share the row where they fit, and stack where the list pane is narrow. */
  .ib-memory__filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-memory__filters > :global(*) {
    flex: 1 1 8rem;
    min-inline-size: 0;
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

  .ib-memory__draft {
    margin: var(--cinder-space-1) 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
