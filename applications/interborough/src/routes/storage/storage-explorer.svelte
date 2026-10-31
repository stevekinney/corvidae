<script lang="ts">
  /**
   * The key explorer: a full-width table of keys (Key, Group, Size) with the selected key beside it.
   * The Group select narrows the table to one group of keys, with the groups storage holds read by
   * skipping (`prefix-discovery.ts`), and the search field narrows it to keys that contain the text.
   * Storage is read in key order and a page at a time, so Load more continues from the last key read
   * (`key-listing.ts`).
   *
   * A key under a prefix the application manages carries a lock, and its pane offers no Edit or
   * Delete (`key-detail.svelte`). Storage keeps no time a key was written, so the table has no
   * Updated column, and it keeps no count per group, so the select lists the groups without one.
   */
  import {
    Alert,
    Button,
    EmptyState,
    SearchField,
    Select,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, STORAGE_COPY } from '../../app/copy.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { getHostStorage } from '../../lib/host-storage.ts';
  import { queryKeys } from '../../lib/query.ts';
  import KeyDetail from './key-detail.svelte';
  import { scanKeyPage } from './key-listing.ts';
  import { discoverPrefixes, keyGroup } from './prefix-discovery.ts';
  import { storageQueryKeys } from './queries.ts';
  import { isManagedKey } from './reserved-prefix.ts';
  import type { StorageConnection } from './storage-client.ts';

  interface Props {
    client: StorageConnection;
    /** Whether the storage can write a key only if it still holds the value read (`weft.storage.capabilities`). */
    conditionalBatch?: boolean | undefined;
  }

  let { client, conditionalBatch = undefined }: Props = $props();

  const copy = STORAGE_COPY;

  let group = $state('');
  let draft = $state('');
  let search = $state('');
  let selectedKey = $state<string | null>(null);

  const listing = createInfiniteQuery(
    () => ({
      queryKey: storageQueryKeys.keys(group, search),
      queryFn: ({ pageParam, signal }) =>
        scanKeyPage(client, { prefix: group, search, after: pageParam, signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor,
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
  const scanned = $derived(pages.reduce((sum, page) => sum + page.scanned, 0));
  const selected = $derived(entries.find((entry) => entry.key === selectedKey));
  const filtered = $derived(group !== '' || search !== '');

  const groupOptions = $derived([
    { value: '', label: copy.allGroups },
    ...(groups.data ?? []).map((prefix) => ({ value: prefix, label: prefix })),
    // A group chosen before the list moved on stays selectable.
    ...(group !== '' && !(groups.data ?? []).includes(group)
      ? [{ value: group, label: group }]
      : []),
  ]);

  function clearFilters(): void {
    group = '';
    draft = '';
    search = '';
  }

  /** Whether the application manages `key`, which is also what an unknown list of prefixes assumes. */
  function managed(key: string): boolean {
    return bureauPrefixes === undefined || isManagedKey(key, bureauPrefixes);
  }
</script>

<div class="ib-storage" data-page="storage">
  <form
    class="ib-storage__filters"
    role="search"
    aria-label={copy.filtersLabel}
    onsubmit={(event) => {
      event.preventDefault();
      search = draft.trim();
    }}
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
    <SearchField
      aria-label={copy.searchLabel}
      placeholder={copy.searchPlaceholder}
      bind:value={draft}
      onSearch={(value) => (search = value.trim())}
      onClear={() => {
        draft = '';
        search = '';
      }}
    />
  </form>

  {#if listing.isError}
    <Alert variant="danger">
      <p class="ib-storage__alert-title">{copy.failed.title}</p>
      <p class="ib-storage__alert-body">{copy.failed.description}</p>
      <Button variant="secondary" onclick={() => void listing.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if listing.isPending}
    <div role="status" aria-busy="true" aria-label={copy.loadingLabel}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if entries.length === 0}
    {#if listing.hasNextPage}
      <EmptyState
        kind="filtered"
        headingLevel={2}
        title={copy.keepSearching.title}
        description={copy.keepSearching.description(scanned)}
      >
        {#snippet action()}
          <Button
            variant="secondary"
            loading={listing.isFetchingNextPage}
            onclick={() => void listing.fetchNextPage()}>{copy.loadMore}</Button
          >
        {/snippet}
      </EmptyState>
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
    <div class="ib-storage__panes">
      <section class="ib-storage__keys" aria-label={copy.tableLabel}>
        <p class="ib-storage__count" data-testid="storage-count">
          {copy.count(entries.length, listing.hasNextPage)}
        </p>
        <Table
          caption={copy.tableLabel}
          stackBelow={false}
          density="condensed"
          class="ib-storage__table"
        >
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{copy.columns.key}</Table.HeaderCell>
              <Table.HeaderCell class="ib-storage__group-column">
                {copy.columns.group}
              </Table.HeaderCell>
              <Table.HeaderCell align="right" class="ib-storage__size-column">
                {copy.columns.size}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each entries as entry (entry.key)}
              <Table.Row
                class="ib-storage__row"
                data-selected={entry.key === selectedKey ? 'true' : undefined}
                data-key-row
              >
                <Table.Cell class="ib-storage__key-cell">
                  <button
                    type="button"
                    class="ib-storage__key"
                    title={entry.key}
                    aria-current={entry.key === selectedKey ? 'true' : undefined}
                    onclick={() => (selectedKey = entry.key)}
                  >
                    {#if managed(entry.key)}
                      <Lock aria-hidden="true" size={12} />
                      <span class="ib-storage__sr">{copy.managedBadge}</span>
                    {/if}
                    <span class="ib-storage__key-text">{entry.key}</span>
                  </button>
                </Table.Cell>
                <Table.Cell class="ib-storage__group-column">
                  <span class="ib-storage__group">{keyGroup(entry.key) ?? copy.noGroup}</span>
                </Table.Cell>
                <Table.Cell align="right" class="ib-storage__size-column">
                  {formatBytes(entry.value.byteLength)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
        {#if listing.hasNextPage}
          <div class="ib-storage__more">
            <Button
              variant="secondary"
              loading={listing.isFetchingNextPage}
              onclick={() => void listing.fetchNextPage()}>{copy.loadMore}</Button
            >
          </div>
        {/if}
      </section>

      <aside class="ib-storage__pane" aria-label={copy.detail.label}>
        {#if selected !== undefined}
          <!-- A key of its own, so another key starts with the editor closed and the fields showing. -->
          {#key selected.key}
            <KeyDetail
              {client}
              entry={selected}
              {bureauPrefixes}
              {conditionalBatch}
              onDeleted={(key) => {
                // Only the key just deleted: another may have been opened while the delete was in flight.
                if (selectedKey === key) selectedKey = null;
              }}
            />
          {/key}
        {:else}
          <EmptyState
            kind="first-use"
            size="compact"
            headingLevel={2}
            title={copy.detail.emptyTitle}
            description={copy.detail.emptyDescription}
          />
        {/if}
      </aside>
    </div>
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
    align-items: flex-end;
  }

  .ib-storage__filters > :global(*) {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .ib-storage__filters > :global(.ib-storage__group-select) {
    flex: 0 1 16rem;
  }

  :global(.ib-storage__group-select select) {
    font-family: var(--cinder-font-mono);
  }

  .ib-storage__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-storage__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  /* The table and the selected key, side by side where the page is wide enough for both. Each track
   * is `minmax(0, 1fr)`: a bare `1fr` grows to its content, and a 2,000-character key would push the
   * page wider than the screen. */
  .ib-storage__panes {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-4);
    align-items: start;
  }

  @container (min-width: 56rem) {
    .ib-storage__panes {
      grid-template-columns: minmax(0, 1fr) minmax(0, 26rem);
    }
  }

  .ib-storage__keys {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-storage__count {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* A fixed layout, so the key column takes the width the others leave and cuts a long key short
   * with an ellipsis; the whole key is in the pane. */
  :global(.ib-storage__table) {
    table-layout: fixed;
    inline-size: 100%;
  }

  :global(.ib-storage__group-column) {
    inline-size: 9rem;
  }

  :global(.ib-storage__size-column) {
    inline-size: 5.5rem;
  }

  @container (max-width: 39.99rem) {
    :global(.ib-storage__group-column) {
      display: none;
    }
  }

  :global(.ib-storage__key-cell) {
    overflow: hidden;
  }

  :global(.ib-storage__row[data-selected='true']) {
    background: color-mix(in oklch, var(--cinder-accent-solid), transparent 92%);
  }

  .ib-storage__key {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-1);
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0;
    color: var(--cinder-accent-text);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    text-align: start;
    background: transparent;
    border: 0;
    cursor: pointer;
  }

  /* The lock keeps its size when a long key takes the rest of the row. */
  .ib-storage__key :global(svg) {
    flex: none;
  }

  .ib-storage__key-text {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ib-storage__group {
    display: block;
    overflow: hidden;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ib-storage__sr {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .ib-storage__more {
    display: flex;
    justify-content: center;
  }

  .ib-storage__pane {
    min-width: 0;
    padding: var(--cinder-space-4);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
</style>
