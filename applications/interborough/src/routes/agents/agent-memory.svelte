<script lang="ts">
  /**
   * The Memory tab of an agent's page (`/agents/:agent/memory`): what the agent remembers of the
   * caller's chats, as a list with the open memory beside it (Cinder's `ListDetail`, the same layout
   * as Chats and Reviews), under the agent's header and tab bar. The open memory is in the address
   * (`?selected=`), so it can be linked and reloaded; choosing one replaces the address in place
   * (the tab stays mounted, with what was typed). The list's header holds Add a memory
   * (`memory-add.svelte`) as a "+", a search that runs as you type, the three filters ("Kind: All",
   * "Written by: Anyone" and "Status: In use") and Export, which is hidden until there is something
   * to export. "Status: Quarantined" lists the memories taken out of use instead (the list operation's
   * `state`), each opening in `memory-quarantined.svelte` with why it was held and the one action,
   * "Release from quarantine"; a quarantined memory is in no other list, so this is where it is
   * inspected, released or forgotten, and the notice after a quarantine links here. The tab's
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
  import { tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import {
    Alert,
    Button,
    DataList,
    EmptyState,
    ListDetail,
    SearchField,
    Select,
    Skeleton,
    StackedListItem,
    Tooltip,
    type ListDetailSelectionChange,
  } from '@lostgradient/cinder';
  import { Brain, ChevronLeft, ChevronRight, Download, Plus, ShieldAlert } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { MEMORY_COPY } from '../../app/copy/memory.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { agentMemoryPath } from '../../lib/agent-paths.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import {
    listMemories,
    memoryFaultOf,
    MEMORY_PAGE_SIZE,
    searchMemories,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, hasPrincipalStore } from '../../lib/scopes.svelte.ts';
  import MemoryAdd from './memory-add.svelte';
  import MemoryChanges, { type ForgetOutcome } from './memory-changes.svelte';
  import MemoryDetail from './memory-detail.svelte';
  import MemoryGovernance from './memory-governance.svelte';
  import MemoryQuarantined from './memory-quarantined.svelte';
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
  /** The value of the address's `view` that names the quarantined memories. */
  const QUARANTINED_VIEW = 'quarantined';
  /** The one item of the entry's own list, which is not an item of the memory list. */
  const QUARANTINED_ENTRY = '__quarantined-memories__';
  const agentId = untrack(() => router.current.params['agent'] ?? '');
  // Only the trusted host directory knows whether another eligible owner exists; an absent answer
  // is not enough to invite a share that the Bureau may refuse.
  const principal = hasPrincipalStore() ? getPrincipalStore() : undefined;
  const sharingAvailable = $derived(principal?.principal?.workspace?.memorySharing === true);

  /** What is typed: a search runs as it changes, and a blank one lists. */
  let typed = $state('');
  const applied = $derived(typed.trim());
  let kindFilter = $state<KindFilter>('all');
  let writerFilter = $state<WriterFilter>('all');
  /**
   * Whether the tab shows the quarantined memories, which can be inspected and released. It is a
   * view of the tab named in the address (`?view=quarantined`), as the archived chats are of
   * Chats, so a reload, Back or a copied link opens the same list and the same open memory.
   */
  const quarantinedView = $derived(router.search.get('view') === QUARANTINED_VIEW);
  /** The memory being released, and what refused the last release, for its details to show. */
  let releasing = $state<string | undefined>(undefined);
  let releaseFault = $state<{ readonly id: string; readonly fault: MemoryFault } | undefined>(
    undefined,
  );
  /** The open memory: the one the address names, so a link and a reload open it. */
  const selectedId = $derived(router.search.get('selected'));
  let automaticallyOpened = $state<string | null>(null);
  // The outlet unmounts this tab a tick after the address leaves it. In that tick no memory is named,
  // and opening the first one would navigate back over the page the person went to.
  const onMemory = $derived(
    router.current.route?.pattern === '/agents/:agent/memory' &&
      router.current.params['agent'] === agentId,
  );
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
  /** The memories forgotten on the page whose Undo still shows, or whose forget is being saved (row 45r). */
  const hidden = new SvelteSet<string>();
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

  /**
   * Whether anything is quarantined, and whether this caller may see it: one quarantined memory is
   * asked for. It decides whether the Quarantined memories row is drawn at the end of the list; a
   * caller that may not view them (a refusal) gets no row.
   */
  const quarantineProbe = createQuery(
    () => ({
      queryKey: queryKeys.memory.quarantinedAny(agentId),
      queryFn: ({ signal }) =>
        listMemories(agentId, { limit: 1, state: 'quarantined' }, { signal }),
      retry: false,
    }),
    undefined,
  );
  const anyQuarantined = $derived((quarantineProbe.data?.memories.length ?? 0) > 0);

  /** The quarantined memories, read only while their view is shown. */
  const quarantinedListing = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.memory.quarantined(agentId),
      queryFn: ({ pageParam, signal }) =>
        listMemories(
          agentId,
          { limit: MEMORY_PAGE_SIZE, offset: pageParam, state: 'quarantined' },
          { signal },
        ),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      enabled: quarantinedView,
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

  const active = $derived(quarantinedView ? quarantinedListing : applied === '' ? listing : search);
  // Infinite queries retain their old pages when a later page fails. Treat that failure as stale as
  // well, so Load more and a search never replace known memory with a generic error state.
  const activeFailed = $derived(
    active.isError ||
      (quarantinedView
        ? quarantinedListing.isFetchNextPageError
        : applied === '' && listing.isFetchNextPageError),
  );
  const activeFault = $derived(memoryFaultOf(active.error));
  const activeError = $derived(
    // The initial ordinary or quarantined scope owns the tab. Later scoped failures keep their
    // initialized controls locally, while retained pages use the shared stale frame and timestamp.
    activeFailed &&
      (active.data !== undefined || listing.data === undefined) &&
      !(quarantinedView && activeFault.kind === 'forbidden')
      ? (active.error ?? new Error(MEMORY_COPY.listFailed))
      : null,
  );
  // Once the initial list has arrived, a different scope (search, filters or quarantined) owns
  // only the results region. Keep the tab frame and its controls mounted while that request reads.
  const framePending = $derived(active.isPending && listing.data === undefined);
  /** Every memory the list or the search holds, before the kind filter, less those just forgotten. */
  const base = $derived.by<MemoryRowData[]>(() => held.filter((row) => !hidden.has(row.id)));
  const held = $derived.by<MemoryRowData[]>(() => {
    if (quarantinedView) {
      // Every quarantined memory read so far: the server does not search them, so what is typed
      // narrows these pages the way the filters do (`shown`).
      return combinePages(
        quarantinedListing.data?.pages,
        (page) => page.memories,
        (memory) => memory.id,
      ).map((memory) => ({ kind: 'memory', id: memory.id, memory, score: null, pinned: false }));
    }
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
  /** Whether the open list has another page: the quarantined one, or the ordinary one. */
  const hasMore = $derived(
    quarantinedView ? quarantinedListing.hasNextPage : applied === '' && listing.hasNextPage,
  );
  /** Whether what is typed narrows the pages read so far: in the quarantined view, which has no search. */
  const searchNarrows = $derived(quarantinedView && applied !== '');
  /** Whether the filters or the search narrow what the pages read so far hold. */
  const narrowed = $derived(filtered || searchNarrows);
  const shown = $derived(
    narrowed
      ? base.filter(
          (row) =>
            row.memory !== undefined &&
            (!searchNarrows || matchesQuery(row.memory.content, applied)) &&
            matchesKind(row.memory, kindFilter) &&
            matchesWriter(row.memory, writerFilter),
        )
      : base,
  );
  /**
   * The open memory when the list does not hold it: one a correction replaced, one the address
   * names, or one the search or the kind filter hides after an explicit choice. It leads the
   * list so it stays visible. An automatically opened row follows the filtered list. In
   * the quarantined view a memory the pages read do not hold still leads it, so its details can
   * say whether more pages are unread or it is not quarantined.
   */
  const pinned = $derived.by<MemoryRowData[]>(() => {
    if (
      selectedId === null ||
      automaticallyOpened === selectedId ||
      shown.some((row) => row.id === selectedId)
    ) {
      return [];
    }
    const known = base.find((row) => row.id === selectedId);
    return [{ kind: 'memory', id: selectedId, memory: known?.memory, score: null, pinned: true }];
  });
  /**
   * Whether the search and the filters are drawn: not in a quarantined view that lists nothing and
   * is narrowed by nothing, where there is nothing to search and the way back is the action.
   */
  const showControls = $derived(
    !quarantinedView || base.length > 0 || narrowed || quarantinedListing.isPending,
  );
  /** The Quarantined memories entry after the list, drawn only when the caller may view some and one exists. */
  const showEntry = $derived(
    !quarantinedView && anyQuarantined && !listing.isPending && !listing.isError,
  );
  const items = $derived<ListRow[]>([
    ...pinned,
    ...shown,
    ...(hasMore ? [{ kind: 'more' as const, id: MORE_KEY }] : []),
  ]);

  /** What the agent remembers, from the pages read so far. */
  const loaded = $derived(
    combinePages(
      listing.data?.pages,
      (page) => page.memories,
      (memory) => memory.id,
    ).filter((memory) => !hidden.has(memory.id)).length,
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

  /** Clears the search and the filters, and stays in the view they were cleared in. */
  function clearAll(): void {
    typed = '';
    kindFilter = 'all';
    writerFilter = 'all';
  }

  /** The tab's address in the quarantined view or out of it, with the memory `id` open when one is named. */
  function viewPath(into: boolean, id?: string): string {
    return agentMemoryPath(agentId, id, into ? QUARANTINED_VIEW : undefined);
  }

  /** The list pane, where the focus is put after a change of view. */
  let pane = $state<HTMLElement | undefined>();

  /**
   * Goes into the quarantined view or back out of it, as Chats goes into its archived chats: a
   * plain click stays in the application and pushes the address, so Back returns, and the focus
   * lands where the person is going on (the way back once in, the Quarantined memories row once
   * out). The open memory belongs to the list it was opened from, so it is closed. A modified
   * click is left to the browser.
   */
  async function switchView(event: MouseEvent | undefined, into: boolean): Promise<void> {
    if (
      event !== undefined &&
      (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
    ) {
      return;
    }
    event?.preventDefault();
    typed = '';
    kindFilter = 'all';
    writerFilter = 'all';
    notice = undefined;
    router.navigate(viewPath(into));
    await tick();
    const target = into
      ? pane?.querySelector<HTMLElement>('[data-memory-view-back]')
      : pane?.querySelector<HTMLElement>('[data-memory-quarantined-entry] a[href]');
    target?.focus();
  }

  /**
   * A memory was released: it left the quarantined list. Open the memory after it (the one before
   * when it was the last) and put the focus on its row, the way a forget goes on to the next; when
   * none is left, close the details and put the focus on the outcome notice, which says what
   * happened. The detail the person was pressing in is gone, so the focus would be nowhere.
   */
  async function released(id: string): Promise<void> {
    notice = undefined;
    const at = shown.findIndex((row) => row.id === id);
    const next = at === -1 ? undefined : (shown[at + 1] ?? shown[at - 1]);
    select(next?.id ?? null);
    await tick();
    if (next === undefined) {
      await governance?.focusOutcome();
      return;
    }
    const row = pane?.querySelector<HTMLElement>(`[data-memory="${CSS.escape(next.id)}"]`);
    (row?.closest('button') ?? row)?.focus();
  }

  /** A memory is gone from the list: close its details if it was the open one, and drop the note about the last change. */
  function closed(id: string): void {
    notice = undefined;
    if (selectedId === id) select(null);
  }

  /**
   * A memory was forgotten (row 45s): drop the note about the last change, and when it was the open
   * one, open the memory after it (the one before when it was the last), or close the details when
   * the list has no other.
   */
  function forgotten(id: string): void {
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

  function open(id: string | null, change?: ListDetailSelectionChange): void {
    // The rows that are not memories (load more, the quarantined memories) open nothing.
    if (id === MORE_KEY) return;
    notice = undefined;
    resume = undefined;
    select(id, change?.automatic === true);
  }

  /**
   * Opens a memory, or the list alone for `null`, in the address, in the view that is shown. It
   * replaces the entry and keeps the tab mounted: the address names what the tab already shows, so
   * what was typed stays typed.
   */
  function select(id: string | null, automatic = false): void {
    if (id === selectedId) return;
    automaticallyOpened = automatic ? id : null;
    router.navigate(viewPath(quarantinedView, id ?? undefined), { replace: true, keep: true });
  }
</script>

<!-- The first read of the list decides whether the tab has anything to show. A failure after that,
     or a search's, is said above the list, which keeps what it shows. -->
<AgentTabState
  tab={AGENT_PAGE_COPY.tabs.memory}
  shape="rows"
  pending={framePending}
  error={activeError}
  updatedAt={active.dataUpdatedAt}
  onRetry={() => void active.refetch()}
  forbiddenDescription={!quarantinedView &&
  applied === '' &&
  listing.data === undefined &&
  memoryFaultOf(listing.error).kind === 'forbidden'
    ? MEMORY_COPY.readForbidden
    : undefined}
>
  <div class="ib-memory" data-agent={agentId} bind:this={pane}>
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
          <Button
            variant="secondary"
            size="sm"
            onclick={() => editAgain(failure)}
            label={MEMORY_COPY.correct.notSaved.editAgain}
          />
        {/if}
      </Alert>
    {/if}

    {#if quarantinedView && quarantinedListing.isError && memoryFaultOf(quarantinedListing.error).kind === 'forbidden'}
      <!-- Viewing the quarantined takes the permission releasing them does: say so, not "none". -->
      <Alert variant="danger" data-quarantined-forbidden>
        <p class="ib-memory__alert-title">{MEMORY_COPY.quarantinedView.forbiddenTitle}</p>
        <p class="ib-memory__alert-body">{MEMORY_COPY.govern.refusal.forbidden.description}</p>
      </Alert>
    {:else if activeFailed && activeError === null && (applied !== '' || listing.data !== undefined)}
      <Alert variant="danger">
        <p class="ib-memory__alert-title">{MEMORY_COPY.listFailed}</p>
        <Button
          variant="secondary"
          size="sm"
          onclick={() => void active.refetch()}
          label={RETRY_LABEL}
        />
      </Alert>
    {/if}

    <MemoryChanges
      bind:this={changes}
      {agentId}
      bind:outcome
      {holds}
      {hidden}
      bind:forgetPending
      onForgotten={forgotten}
    />
    <MemoryGovernance
      bind:this={governance}
      {agentId}
      {holds}
      bind:pending={governancePending}
      bind:exporting
      bind:releasing
      bind:releaseFault
      onQuarantined={closed}
      onReleased={(id) => void released(id)}
      onSeeQuarantined={() => void switchView(undefined, true)}
    />
    <MemoryAdd bind:this={adding} {agentId} {agentName} onAdded={added} onUndone={closed} />

    <!-- A filter that hides the search hits is not "no match": the hits are there. -->
    {#snippet emptiness()}
      {#if active.isPending}
        <div role="status" aria-busy="true" aria-label={MEMORY_COPY.loading}>
          <Skeleton height="1.5rem" width="50%" />
          <Skeleton height="6rem" />
        </div>
      {:else if activeFailed}
        <!-- The fault is reported above the list, so this is not read as an empty agent. -->
      {:else if quarantinedView && base.length === 0}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title={MEMORY_COPY.quarantinedView.empty.title}
          description={MEMORY_COPY.quarantinedView.empty.description}
        >
          {#snippet action()}
            <Button
              variant="secondary"
              href={router.href(viewPath(false))}
              onclick={(event: MouseEvent) => void switchView(event, false)}
              label={MEMORY_COPY.quarantinedView.empty.back}
            />
          {/snippet}
        </EmptyState>
      {:else if narrowed && (applied === '' || base.length > 0)}
        <EmptyState
          kind="filtered"
          headingLevel={2}
          title={MEMORY_COPY.noFiltered.title}
          description={MEMORY_COPY.noFiltered.description}
          clearFiltersLabel={MEMORY_COPY.clearMatch}
          onClearFilters={clearAll}
        />
      {:else if applied !== ''}
        <EmptyState
          kind="filtered"
          headingLevel={2}
          title={MEMORY_COPY.noMatch.title(applied)}
          description={MEMORY_COPY.noMatch.description}
          clearFiltersLabel={MEMORY_COPY.clearMatch}
          onClearFilters={clearAll}
        />
      {:else}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title={MEMORY_COPY.nothing.title}
          description={MEMORY_COPY.nothing.description}
        >
          {#snippet icon()}<Brain aria-hidden="true" />{/snippet}
          {#snippet action()}
            <Button
              data-changes
              variant="primary"
              onclick={() => adding?.ask()}
              label={MEMORY_COPY.add.action}
            />
          {/snippet}
        </EmptyState>
      {/if}
    {/snippet}

    <!-- The way to the quarantined memories is the list's footer, not one of its rows, so an empty
         list still says it is empty above it, J and K never land on it, and it is not selectable.
         It is drawn only while one is quarantined and the caller may view it. Cinder's row draws the
         link, so its click is read where it lands, as Chats' archived row's is. -->
    {#snippet quarantinedEntry()}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="ib-memory__entry"
        data-memory-quarantined-entry
        onclick={(event) => {
          if (event.target instanceof Element && event.target.closest('a[href]') !== null) {
            void switchView(event, true);
          }
        }}
      >
        <DataList
          items={[QUARANTINED_ENTRY]}
          key={(entry: string) => entry}
          aria-label={MEMORY_COPY.quarantinedView.title}
        >
          {#snippet children()}
            <StackedListItem href={router.href(viewPath(true))} trailingGlyph>
              {#snippet leading()}<ShieldAlert aria-hidden="true" size={16} />{/snippet}
              {#snippet title()}{MEMORY_COPY.quarantinedView.title}{/snippet}
              {#snippet trailing()}<ChevronRight aria-hidden="true" size={16} />{/snippet}
            </StackedListItem>
          {/snippet}
        </DataList>
      </div>
    {/snippet}

    <div class="ib-memory__frame" data-shortcut-region="list-detail">
      <ListDetail
        {items}
        {...showEntry ? { listFooter: quarantinedEntry } : {}}
        key={(row: ListRow) => row.id}
        label={MEMORY_COPY.listLabel}
        detailLabel={MEMORY_COPY.detail.heading}
        backLabel={quarantinedView
          ? MEMORY_COPY.quarantinedView.detailBackLabel
          : MEMORY_COPY.backToList}
        emptyTitle={MEMORY_COPY.nothingOpen.title}
        emptyDescription={MEMORY_COPY.nothingOpen.description}
        selectedKey={selectedId}
        onSelectedKeyChange={open}
        openFirst={onMemory}
        selectionParameter={null}
        storageKey="interborough-memory"
      >
        {#snippet header()}
          {#if quarantinedView}
            <!-- The quarantined view's way back to the memories, above its title, as Chats' archived view has. -->
            <div class="ib-memory__back-row">
              <Tooltip text={MEMORY_COPY.quarantinedView.backLabel}>
                <Button
                  data-memory-view-back
                  href={router.href(viewPath(false))}
                  variant="ghost"
                  size="sm"
                  aria-label={MEMORY_COPY.quarantinedView.backLabel}
                  onclick={(event: MouseEvent) => void switchView(event, false)}
                >
                  <ChevronLeft aria-hidden="true" size={16} />
                  {MEMORY_COPY.quarantinedView.back}
                </Button>
              </Tooltip>
            </div>
            <h2 class="ib-memory__view-title" data-memory-view-title>
              {MEMORY_COPY.quarantinedView.title}
            </h2>
          {/if}
          {#if showControls}
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
              {#if !firstUse && !quarantinedView}
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
          {/if}
          {#if loaded > 0 && !quarantinedView}
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
          {#if applied !== '' && base.length > 0 && !quarantinedView}
            <p class="ib-memory__count" role="status" data-testid="memory-match-count">
              {MEMORY_COPY.matchCount(base.length, total, searchFilled)}
            </p>
          {/if}
          {#if narrowed && base.length > 0}
            <p class="ib-memory__count" data-testid="memory-kind-note">
              {MEMORY_COPY.filter.note(shown.length, base.length, hasMore)}
            </p>
          {/if}
        {/snippet}
        {#snippet list(row, context)}
          {#if row.kind === 'more'}
            {@const paging = quarantinedView ? quarantinedListing : listing}
            <div class="ib-memory__more">
              <Button
                variant="secondary"
                size="sm"
                disabled={paging.isFetchingNextPage}
                onclick={() => void paging.fetchNextPage()}
                label={MEMORY_COPY.loadMore}
              />
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
              quarantined={quarantinedView}
              unavailable={quarantinedView &&
                row.memory === undefined &&
                quarantinedListing.data !== undefined}
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
            {#if quarantinedView}
              <MemoryQuarantined
                id={row.id}
                {agentName}
                memory={row.kind === 'memory' ? row.memory : undefined}
                missing={quarantinedListing.data === undefined
                  ? undefined
                  : quarantinedListing.hasNextPage
                    ? 'unread'
                    : 'absent'}
                {governancePending}
                releasing={releasing === row.id}
                fault={releaseFault?.id === row.id ? releaseFault.fault : undefined}
                onRelease={(memory) => governance?.releaseMemory(memory)}
                onForget={(memory) => changes?.askToForget(memory)}
              />
            {:else}
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
                {sharingAvailable}
                onShare={(memory) => governance?.askToShare(memory)}
                onHold={(id, change) => governance?.changeHold(id, change)}
                onQuarantine={(memory) => governance?.askToQuarantine(memory)}
              />
            {/if}
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
     the window leaves under the agent's header and tab bar. It draws no box: the list and the open
     memory sit on the page, and ListDetail's divider is the one line between them. */
  .ib-memory__frame {
    block-size: max(28rem, calc(100dvh - 18rem));
    min-inline-size: 0;
    overflow: hidden;
  }

  /* The quarantined view's way back sits above its title, its chevron lined up with the title's start. */
  .ib-memory__back-row {
    display: flex;
    margin-inline-start: calc(-1 * var(--cinder-space-2));
  }

  .ib-memory__view-title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
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
