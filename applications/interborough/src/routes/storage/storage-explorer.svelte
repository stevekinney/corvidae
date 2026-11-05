<script lang="ts">
  /**
   * The key explorer: a table of keys (Key, Group, Size, Updated) with the selected key beside it.
   * One row of controls narrows the table: a Group select (the groups storage holds, named in plain
   * words, found by skipping through the key order, `prefix-discovery.ts`), a Starts with / Range
   * switch, and either a field for the text a key starts with or two fields for a first and a last
   * key. Both narrow by key order, so the server does the work (`key-listing.ts`). A range applies as
   * it is typed; one whose end sorts before its start says so under the fields and leaves the table
   * on the last range that was one, with a note saying which.
   *
   * Storage is read a page at a time, and the table loads the next page when its end scrolls into
   * view. Its footer says how many keys are loaded and, where storage can count them, how many there
   * are (the host counts a prefix, never a range).
   *
   * A key under a prefix the application manages is locked, which its pane says and where it offers no
   * Edit or Delete (`key-detail.svelte`). The scan carries each key's write time (`updatedAt`, null for a backend
   * that records none), which the Updated column words absolutely, in Central time ("Today, 10:44
   * AM"). A UUID in a key is cut to its first eight characters in the table; the row's title and the
   * pane hold the whole key. The table and the key's pane are Cinder's list and detail: the table in
   * the list slot, scrolling inside its pane with a visible scrollbar and a fade at the end so the
   * page never scrolls sideways, and the pane pinned beside it. Where the page is too narrow for
   * both it shows one at a time, the pane with a Back button.
   *
   * While the keys are read the filters stay and the table is a skeleton, drawn only after 300 ms;
   * after 10 s it says the read is taking longer than usual and offers Cancel, which stops the read
   * and says so. When "Scroll to load more" fails the keys already loaded stay and the footer becomes
   * Cinder's load more in its retry state, which a keyboard can press.
   */
  import {
    Alert,
    Button,
    DataTable,
    EmptyState,
    ErrorState,
    formatDateTime,
    formatTimeZoneLabel,
    Input,
    ListDetail,
    LoadMore,
    SearchField,
    Segment,
    SegmentedControl,
    Select,
    Skeleton,
  } from '@lostgradient/cinder';
  import type { DataTableColumn } from '@lostgradient/cinder';
  import { Database } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RETRY_LABEL, STORAGE_COPY } from '../../app/copy.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { getHostStorage, getHostStorageSummary } from '../../lib/host-storage.ts';
  import { queryKeys } from '../../lib/query.ts';
  import KeyDetail from './key-detail.svelte';
  import {
    countedPrefix,
    rangeProblem,
    scanBounds,
    scanKeyPage,
    type KeyFilter,
  } from './key-listing.ts';
  import { discoverPrefixes } from './prefix-discovery.ts';
  import { storageQueryKeys } from './queries.ts';
  import { abbreviateKey, groupName, keyGroupName } from './storage-groups.ts';
  import type { StorageConnection } from './storage-client.ts';

  interface Props {
    client: StorageConnection;
    /** Whether the storage can write a key only if it still holds the value read (`weft.storage.capabilities`). */
    conditionalBatch?: boolean | undefined;
  }

  let { client, conditionalBatch = undefined }: Props = $props();

  const copy = STORAGE_COPY;
  const queryClient = useQueryClient();

  /** How long a read runs before the skeleton is drawn, so a quick read never flashes one. */
  const LOADING_DELAY_MILLISECONDS = 300;

  /** How long a read runs before the skeleton says it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;

  /** The widest the Group column grows before it ends a name with an ellipsis. */
  const GROUP_COLUMN_WIDTH = 168;

  /** How wide the table's pane starts, in pixels, before the divider is moved. */
  const LIST_PANE_WIDTH = 640;

  /**
   * The width of the layout below which the key's pane sits under the table instead of beside it, in
   * pixels: the table's pane starts at 640 and the detail needs 320 of its own.
   */
  const STACK_BELOW_WIDTH = 960;

  /** The widest the divider gives the table's pane, in pixels: its four columns need more than a list of rows. */
  const LIST_PANE_MAXIMUM_WIDTH = 1000;

  /** The widest the Key column grows before it ends a key with an ellipsis, so Size and Updated stay in view. */
  const KEY_COLUMN_WIDTH = 232;

  type Mode = 'prefix' | 'range';

  let group = $state('');
  let mode = $state<Mode>('prefix');
  let text = $state('');
  let start = $state('');
  let end = $state('');
  let selectedKey = $state<string | null>(null);
  // "Cancel" in the "Still loading" line stopped the read of the keys, and "Try again" reads them
  // again. TanStack puts a first read that is cancelled back to pending, so the page keeps what it
  // was told here. A new filter is a new read.
  let loadStopped = $state(false);
  // "Scroll to load more" failed: the footer is Cinder's load more in its retry state until a read
  // of the next page succeeds, or the filter changes.
  let loadMoreFailed = $state(false);

  const filter = $derived<KeyFilter>(
    mode === 'prefix' ? { mode, group, text } : { mode, group, start, end },
  );
  const problem = $derived(mode === 'range' ? rangeProblem(start, end) : undefined);

  // What the table reads: the filter, until it stops being one. A range whose end sorts before its
  // start is no range, so the table keeps the last filter that was one, and says so.
  let applied = $state.raw<KeyFilter>({ mode: 'prefix', group: '', text: '' });
  $effect(() => {
    if (problem === undefined) applied = filter;
  });

  const bounds = $derived(scanBounds(applied));
  const boundsKey = $derived(JSON.stringify(bounds ?? null));
  const counted = $derived(countedPrefix(applied));

  const listing = createInfiniteQuery(
    () => ({
      queryKey: storageQueryKeys.keys(boundsKey),
      queryFn: ({ pageParam, signal }) => scanKeyPage(client, { bounds, after: pageParam, signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor,
      retry: false,
    }),
    undefined,
  );

  // How many keys there are under the prefix being read. Only the footer depends on it: a read that
  // fails leaves the footer saying how many are loaded, and the table is unaffected.
  const summary = createQuery(
    () => ({
      queryKey: queryKeys.hostStorageSummary(counted ?? ''),
      queryFn: ({ signal }) => getHostStorageSummary(counted ?? '', { signal }),
      enabled: counted !== undefined,
      staleTime: 30_000,
      retry: false,
    }),
    undefined,
  );

  // The groups in storage. Only the Group select depends on them: a read that fails leaves it with
  // All groups, and the table is unaffected.
  const groups = createQuery(
    () => ({
      queryKey: storageQueryKeys.prefixes(),
      queryFn: ({ signal }) => discoverPrefixes(client, { signal }),
      staleTime: 5 * 60_000,
      retry: false,
    }),
    undefined,
  );

  // The Bureau's key prefixes, from the host. Until they are known, no key is editable.
  const hostStorage = createQuery(
    () => ({
      queryKey: queryKeys.hostStorage(),
      queryFn: ({ signal }) => getHostStorage({ signal }),
      staleTime: Infinity,
      retry: false,
    }),
    undefined,
  );
  const bureauPrefixes = $derived(hostStorage.data?.bureauKeyPrefixes);

  const pages = $derived(listing.data?.pages ?? []);
  const entries = $derived(
    combinePages(
      pages,
      (page) => page.entries,
      (entry) => entry.key,
    ),
  );
  const filtered = $derived(group !== '' || text !== '' || start !== '' || end !== '');
  const zoneLabel = formatTimeZoneLabel(Date.now(), { style: 'long' });

  const groupOptions = $derived([
    { value: '', label: copy.allGroups },
    ...(groups.data ?? []).map((prefix) => ({ value: prefix, label: groupName(prefix) })),
    // A group chosen before the list moved on stays selectable.
    ...(group !== '' && !(groups.data ?? []).includes(group)
      ? [{ value: group, label: groupName(group) }]
      : []),
  ]);

  type KeyRow = {
    id: string;
    key: string;
    group: string;
    size: string;
    updated: string;
  };

  const rows = $derived<KeyRow[]>(
    entries.map((entry) => ({
      id: entry.key,
      key: entry.key,
      group: keyGroupName(entry.key, copy.noGroup),
      size: formatBytes(entry.value.byteLength),
      updated:
        entry.updatedAt === null
          ? copy.noUpdated
          : formatDateTime(entry.updatedAt, { dayWords: 'today' }),
    })),
  );

  const columns = $derived<DataTableColumn<KeyRow>[]>([
    {
      key: 'key',
      label: copy.columns.key,
      truncate: true,
      monospace: true,
      maxWidth: KEY_COLUMN_WIDTH,
    },
    { key: 'group', label: copy.columns.group, truncate: true, maxWidth: GROUP_COLUMN_WIDTH },
    { key: 'size', label: copy.columns.size, align: 'end' },
    { key: 'updated', label: copy.columns.updated(zoneLabel) },
  ]);

  function clearFilters(): void {
    group = '';
    text = '';
    start = '';
    end = '';
  }

  // A new filter reads the keys afresh, so what happened to the last read does not carry over.
  $effect(() => {
    void boundsKey;
    loadStopped = false;
    loadMoreFailed = false;
  });

  function stopLoading(): void {
    loadStopped = true;
    void queryClient.cancelQueries({ queryKey: storageQueryKeys.keys(boundsKey) });
  }

  function readAgain(): void {
    loadStopped = false;
    void listing.refetch();
  }

  /** Reads the next page, and rejects when it fails, which is what Cinder's load more retries. */
  async function fetchMore(): Promise<void> {
    await listing.fetchNextPage({ throwOnError: true });
  }

  function loadMore(): void {
    if (!listing.hasNextPage || listing.isFetchingNextPage || loadMoreFailed) return;
    void fetchMore().catch(() => {
      loadMoreFailed = true;
    });
  }

  async function retryLoadMore(): Promise<void> {
    await fetchMore();
    loadMoreFailed = false;
  }

  const totalKeys = $derived(counted === undefined ? undefined : summary.data?.keyCount);

  const lastResult = $derived(
    problem !== undefined && applied.mode === 'range'
      ? copy.range.lastResult(entries.length, applied.start, applied.end)
      : undefined,
  );
</script>

<div class="ib-storage" data-page="storage">
  <form
    class="ib-storage__filters"
    role="search"
    aria-label={copy.filtersLabel}
    onsubmit={(event) => event.preventDefault()}
  >
    <Select
      id="ib-storage-group"
      label={copy.groupLabel}
      labelVisible={false}
      class="ib-storage__group-select"
      options={groupOptions}
      value={group}
      onchange={(event) => {
        group = event.currentTarget.value;
        selectedKey = null;
      }}
    />
    <SegmentedControl
      id="ib-storage-mode"
      label={copy.modeLabel}
      labelVisible={false}
      value={mode}
      onValueChange={(next) => {
        mode = next === 'range' ? 'range' : 'prefix';
      }}
    >
      <Segment value="prefix">{copy.modeStartsWith}</Segment>
      <Segment value="range">{copy.modeRange}</Segment>
    </SegmentedControl>
    {#if mode === 'prefix'}
      <SearchField
        aria-label={copy.searchLabel}
        placeholder={copy.searchPlaceholder}
        class="ib-storage__search"
        bind:value={text}
        onClear={() => (text = '')}
      />
    {:else}
      <div class="ib-storage__range" role="group" aria-label={copy.range.label}>
        <div class="ib-storage__range-field">
          <Input
            id="ib-storage-range-start"
            label={copy.range.startLabel}
            labelVisible={false}
            variant="code"
            placeholder={copy.range.startPlaceholder}
            bind:value={start}
          />
        </div>
        <span class="ib-storage__to">{copy.range.to}</span>
        <div class="ib-storage__range-field">
          <Input
            id="ib-storage-range-end"
            label={copy.range.endLabel}
            labelVisible={false}
            variant="code"
            placeholder={copy.range.endPlaceholder}
            aria-invalid={problem === undefined ? undefined : 'true'}
            aria-describedby={problem === undefined ? undefined : 'ib-storage-range-problem'}
            bind:value={end}
          />
        </div>
      </div>
    {/if}
  </form>

  {#if problem !== undefined}
    <p class="ib-storage__problem" id="ib-storage-range-problem" role="alert">{problem}</p>
  {/if}

  {#if listing.isError && listing.data === undefined}
    <Alert variant="danger">
      <p class="ib-storage__alert-title">{copy.failed.title}</p>
      <p class="ib-storage__alert-body">{copy.failed.description}</p>
      <Button variant="secondary" onclick={() => void listing.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if listing.isPending && loadStopped}
    <ErrorState
      bordered
      headingLevel={2}
      tone="neutral"
      title={copy.stopped.title}
      description={copy.stopped.description}
      retryLabel={copy.stopped.tryAgain}
      retryVariant="secondary"
      onRetry={readAgain}
    />
  {:else if listing.isPending}
    <div data-testid="storage-loading" aria-busy="true">
      <Skeleton
        variant="list"
        rows={5}
        statusMarker="dot"
        statusColumn={false}
        delay={LOADING_DELAY_MILLISECONDS}
        stillLoadingAfter={STILL_LOADING_MILLISECONDS}
        label={copy.loadingLabel}
        onCancel={stopLoading}
      />
    </div>
  {:else if entries.length === 0}
    {#if applied.mode === 'range' && (applied.start !== '' || applied.end !== '')}
      <EmptyState
        kind="filtered"
        headingLevel={2}
        title={copy.noKeysInRange.title}
        description={copy.noKeysInRange.description}
      />
    {:else if filtered}
      <EmptyState
        kind="filtered"
        headingLevel={2}
        title={copy.noMatches.title}
        description={copy.noMatches.description}
        clearFiltersLabel={copy.noMatches.clear}
        onClearFilters={clearFilters}
      />
    {:else}
      <EmptyState
        kind="first-use"
        headingLevel={2}
        title={copy.empty.title}
        description={copy.empty.description}
      />
    {/if}
  {:else}
    {#if lastResult !== undefined}
      <p class="ib-storage__note" data-testid="storage-last-result">{lastResult}</p>
    {/if}
    <ListDetail
      items={entries}
      key={(entry) => entry.key}
      label={copy.tableLabel}
      detailLabel={copy.detail.paneLabel}
      class="ib-storage__layout"
      selectionParameter={null}
      bind:selectedKey
      storageKey="interborough-storage"
      defaultListWidth={LIST_PANE_WIDTH}
      maximumListWidth={LIST_PANE_MAXIMUM_WIDTH}
      stackBelow={STACK_BELOW_WIDTH}
    >
      {#snippet listBody(body)}
        <DataTable
          {columns}
          {rows}
          caption={copy.tableLabel}
          density="condensed"
          class="ib-storage__table"
          getRowId={(row) => row.id}
          openRowId={body.selectedKey}
          onRowOpen={(row) => body.open(row.key)}
          onReachEnd={listing.hasNextPage ? loadMore : undefined}
        >
          {#snippet cell({ row, column, value })}
            {#if column.key === 'key'}
              {abbreviateKey(row.key)}
            {:else}
              {value}
            {/if}
          {/snippet}
          {#snippet footer()}
            {#if loadMoreFailed}
              <LoadMore
                variant="footer"
                failed
                hasMore={listing.hasNextPage}
                loading={listing.isFetchingNextPage}
                loadedCount={entries.length}
                {...totalKeys === undefined
                  ? {}
                  : { totalCount: Math.max(totalKeys, entries.length) }}
                itemLabel={copy.loadMore.itemLabel}
                retryLabel={copy.loadMore.retry}
                endOfListMessage=""
                onLoadMore={retryLoadMore}
              />
            {:else}
              <span class="ib-storage__footer" data-testid="storage-count">
                {copy.footer(entries.length, totalKeys, listing.hasNextPage)}
              </span>
            {/if}
          {/snippet}
        </DataTable>
      {/snippet}
      {#snippet detail(entry)}
        <!-- A key of its own, so another key starts with the editor closed and the fields showing. -->
        {#key entry.key}
          <KeyDetail
            {client}
            {entry}
            {bureauPrefixes}
            {conditionalBatch}
            onDeleted={(key) => {
              // Only the key just deleted: another may have been opened while the delete was in flight.
              if (selectedKey === key) selectedKey = null;
            }}
          />
        {/key}
      {/snippet}
      {#snippet empty()}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={2}
          title={copy.detail.emptyTitle}
          description={copy.detail.emptyDescription}
        >
          {#snippet icon()}<Database aria-hidden="true" />{/snippet}
        </EmptyState>
      {/snippet}
    </ListDetail>
  {/if}
</div>

<style>
  .ib-storage {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
    container-type: inline-size;
  }

  .ib-storage__filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
  }

  .ib-storage__filters > :global(.ib-storage__group-select) {
    flex: 0 1 14rem;
    min-width: 0;
  }

  .ib-storage__filters > :global(.ib-storage__search) {
    flex: 0 1 18rem;
    min-width: 0;
  }

  .ib-storage__range {
    display: flex;
    flex: 1 1 20rem;
    align-items: center;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-storage__range-field {
    flex: 1 1 8rem;
    min-width: 0;
  }

  .ib-storage__to {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* On a narrow page each control takes its own row. */
  @container (max-width: 39.99rem) {
    .ib-storage__filters > :global(.ib-storage__group-select),
    .ib-storage__filters > :global(.ib-storage__search),
    .ib-storage__range {
      flex: 1 1 100%;
    }
  }

  :global(.ib-storage__group-select select) {
    font-family: var(--cinder-font-sans);
  }

  .ib-storage__problem {
    margin: 0;
    color: var(--cinder-status-danger-text);
    font-size: var(--cinder-text-sm);
  }

  .ib-storage__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-storage__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  /* The table and the selected key, Cinder's list and detail, in one bordered box. Side by side the
   * two fill the height they are given and scroll each pane on its own, so the box has one; under
   * the stacked and the one-pane layouts they flow with the page. */
  .ib-storage :global(.ib-storage__layout) {
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-storage :global(.ib-storage__layout[data-cinder-layout='split']) {
    block-size: max(28rem, calc(100dvh - 22rem));
  }

  .ib-storage__note,
  .ib-storage__footer {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
