<script lang="ts">
  /**
   * `/audit`: the Bureau's audit trail, searched by time, type, and resource. The trail comes back
   * oldest first, as the Bureau returns it, as metadata only, and Load more follows the cursor the
   * Bureau hands back. The address owns the filters (`audit-filter.ts`), so a search can be linked
   * to, and a filter that is set stays set while the next page loads.
   *
   * The Bureau shows each caller the records about what it owns, so the page holds no scope of its
   * own: owner scoping is the gate. Whether the trail is empty, failing, or refused is the view
   * frame's to say (`app/view-probes.ts`), and this page speaks only for a search that fails after
   * the view opened, and for one that matches nothing.
   */
  import { Alert, Button, DatePicker, EmptyState, Input, Table } from '@lostgradient/cinder';
  import { SearchX } from '@lucide/svelte';
  import { createInfiniteQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { AUDIT_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
  import { queryAudit, type AuditRecord } from '../../lib/bureau-audit.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    draftFromSearch,
    EMPTY_AUDIT_DRAFT,
    filterOf,
    pathOf,
  } from './audit-filter.ts';

  // The filters the address holds are the ones the trail is asked with.
  const applied = $derived(draftFromSearch(router.current.search));
  const filter = $derived(filterOf(applied));
  const filtered = $derived(Object.keys(filter).length > 0);

  // The form starts from the address, and is the person's until they search.
  // The date picker clears its value to `undefined`.
  let since = $state<string | undefined>(untrack(() => applied.since || undefined));
  let type = $state(untrack(() => applied.type));
  let resource = $state(untrack(() => applied.resource));

  const trail = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.audit.list(filter),
      queryFn: ({ pageParam, signal }) =>
        queryAudit(filter, pageParam === '' ? undefined : pageParam, { signal }),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      retry: false,
    }),
    undefined,
  );

  const records = $derived((trail.data?.pages ?? []).flatMap((page) => page.records));

  function search(event: SubmitEvent): void {
    event.preventDefault();
    router.navigate(pathOf({ since: since ?? '', type, resource }), { replace: true });
  }

  function clear(): void {
    since = undefined;
    type = EMPTY_AUDIT_DRAFT.type;
    resource = EMPTY_AUDIT_DRAFT.resource;
    router.navigate(pathOf(EMPTY_AUDIT_DRAFT), { replace: true });
  }

  /** The record's own key: its time and its place in the trail's order within that time. */
  function keyOf(record: AuditRecord): string {
    return `${record.timestamp}#${String(record.sequence ?? '')}`;
  }

  function detailOf(record: AuditRecord): string {
    return Object.entries(record.detail ?? {})
      .map(([name, value]) => `${name}: ${String(value)}`)
      .join(' · ');
  }

  function timeOf(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
  }
</script>

<section class="weft-audit" aria-labelledby="weft-audit-title" data-page="audit">
  <h1 id="weft-audit-title" class="weft-audit__title">{VIEW_COPY.audit.label}</h1>

  <form
    class="weft-audit__search"
    role="search"
    aria-label={AUDIT_COPY.searchLabel}
    onsubmit={search}
  >
    <DatePicker
      id="weft-audit-since"
      label={AUDIT_COPY.sinceLabel}
      description={AUDIT_COPY.sinceDescription}
      granularity="minute"
      bind:value={since}
    />
    <Input
      id="weft-audit-type"
      label={AUDIT_COPY.typeLabel}
      description={AUDIT_COPY.typeDescription}
      bind:value={type}
    />
    <Input
      id="weft-audit-resource"
      label={AUDIT_COPY.resourceLabel}
      description={AUDIT_COPY.resourceDescription}
      bind:value={resource}
    />
    <div class="weft-audit__actions">
      <Button type="submit" variant="primary" size="sm"
        >{AUDIT_COPY.searchAction}</Button
      >
      <Button type="button" variant="secondary" size="sm" onclick={clear}
        >{AUDIT_COPY.clearAction}</Button
      >
    </div>
  </form>

  {#if trail.isError}
    <Alert variant="danger">
      <p class="weft-audit__alert-title">{AUDIT_COPY.failed.title}</p>
      <p class="weft-audit__alert-body">{AUDIT_COPY.failed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void trail.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if trail.isPending}
    <p role="status" aria-busy="true" class="weft-audit__muted">{VIEW_COPY.audit.loading.title}</p>
  {:else if records.length === 0}
    <EmptyState
      title={filtered ? AUDIT_COPY.noMatches.title : VIEW_COPY.audit.empty?.title ?? ''}
      description={filtered
        ? AUDIT_COPY.noMatches.description
        : VIEW_COPY.audit.empty?.description ?? ''}
    >
      {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <Table scrollable caption={AUDIT_COPY.caption}>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{AUDIT_COPY.timeColumn}</Table.HeaderCell>
          <Table.HeaderCell>{AUDIT_COPY.typeColumn}</Table.HeaderCell>
          <Table.HeaderCell>{AUDIT_COPY.resourceColumn}</Table.HeaderCell>
          <Table.HeaderCell>{AUDIT_COPY.actorColumn}</Table.HeaderCell>
          <Table.HeaderCell>{AUDIT_COPY.detailColumn}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each keyedByOccurrence(records, keyOf) as { key, item: record } (key)}
          <Table.Row data-record={record.sequence ?? ''}>
            <Table.Cell class="weft-audit__time">
              <time datetime={record.timestamp}>{timeOf(record.timestamp)}</time>
            </Table.Cell>
            <Table.Cell class="weft-audit__mono">{record.type}</Table.Cell>
            <Table.Cell class="weft-audit__mono">{record.resource}</Table.Cell>
            <Table.Cell>{record.principal ?? AUDIT_COPY.noActor}</Table.Cell>
            <Table.Cell class="weft-audit__detail">{detailOf(record)}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
    {#if trail.hasNextPage}
      <div class="weft-audit__more">
        <Button
          variant="secondary"
          size="sm"
          disabled={trail.isFetchingNextPage}
          onclick={() => void trail.fetchNextPage()}>{AUDIT_COPY.loadMore}</Button
        >
      </div>
    {/if}
  {/if}
</section>

<style>
  .weft-audit {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-audit__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }

  .weft-audit__search {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 12px 16px;
    align-items: start;
  }

  .weft-audit__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    grid-column: 1 / -1;
  }

  .weft-audit__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-audit__alert-body {
    margin: 4px 0 8px;
  }

  .weft-audit__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-audit__more {
    display: flex;
    justify-content: center;
  }

  :global(.weft-audit__mono) {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  :global(.weft-audit__time) {
    white-space: nowrap;
  }

  :global(.weft-audit__detail) {
    color: var(--cinder-text-subtle);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }
</style>
