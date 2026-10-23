<script lang="ts">
  /**
   * `/audit`: the Bureau's audit trail, searched by time, type, and resource. The trail comes back
   * oldest first, as the Bureau returns it, as metadata only, and Load more follows the cursor the
   * Bureau hands back. The address owns the filters (`audit-filter.ts`), so a search can be linked
   * to, and a filter that is set stays set while the next page loads.
   *
   * Nothing here asks for a syntax. Since is a date-time picker. Type is a select of the types the
   * trail has shown (the first page of the whole trail, and every page loaded since), with the one
   * the address names, and Other for a type it has not shown yet. The resource is a kind (Chat,
   * Agent, Schedule, Workflow, or a run id) and an id, and the `kind:<id>` string is built from them
   * (`splitResource` and `joinResource`), so no one types `schedule:`. The address and the Bureau
   * still hold the one resource string.
   *
   * Each record is a row: when, what, about what, by whom, and a line of detail. The raw record is
   * under the row's disclosure.
   *
   * The Bureau shows each caller the records about what it owns, so the page holds no scope of its
   * own: owner scoping is the gate. Whether the trail is empty, failing, or refused is the view
   * frame's to say (`app/view-probes.ts`), and this page speaks only for a search that fails after
   * the view opened, and for one that matches nothing.
   */
  import {
    Alert,
    Button,
    CodeBlock,
    Collapsible,
    DatePicker,
    EmptyState,
    Input,
    Select,
  } from '@lostgradient/cinder';
  import { SearchX } from '@lucide/svelte';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';
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
    joinResource,
    pathOf,
    RESOURCE_KINDS,
    splitResource,
    type ResourceKind,
  } from './audit-filter.ts';

  /** The Type select's value for "a type that is not in the list", which brings a field to type it in. */
  const OTHER_TYPE = '__other__';

  // The filters the address holds are the ones the trail is asked with.
  const applied = $derived(draftFromSearch(router.current.search));
  const filter = $derived(filterOf(applied));
  const filtered = $derived(Object.keys(filter).length > 0);

  // The form starts from the address, and is the person's until they search.
  // The date picker clears its value to `undefined`.
  let since = $state<string | undefined>(untrack(() => applied.since || undefined));
  let typeChoice = $state(untrack(() => applied.type.trim()));
  let otherType = $state('');
  let resourceKind = $state<ResourceKind | ''>(untrack(() => splitResource(applied.resource).kind));
  let resourceId = $state(untrack(() => splitResource(applied.resource).id));

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

  // The types the trail has shown: its first page, whatever was searched, and any page loaded since.
  // A search that narrows the trail still offers every type the first page had.
  const wholeTrail = createQuery(
    () => ({
      queryKey: queryKeys.audit.types(),
      queryFn: ({ signal }) => queryAudit({}, undefined, { limit: 100, signal }),
      retry: false,
      staleTime: 60_000,
    }),
    undefined,
  );

  const records = $derived((trail.data?.pages ?? []).flatMap((page) => page.records));

  const typeOptions = $derived.by(() => {
    const seen = new Set<string>();
    for (const record of [...(wholeTrail.data?.records ?? []), ...records]) seen.add(record.type);
    if (applied.type.trim() !== '') seen.add(applied.type.trim());
    return [
      { value: '', label: AUDIT_COPY.anyType },
      ...[...seen].toSorted().map((type) => ({ value: type, label: type })),
      { value: OTHER_TYPE, label: AUDIT_COPY.otherType },
    ];
  });

  const kindOptions = [
    { value: '', label: AUDIT_COPY.anyResource },
    ...RESOURCE_KINDS.map(({ kind, label }) => ({ value: kind, label })),
  ];

  /** The kind a select value names, or none for the first option. */
  function kindOf(value: string): ResourceKind | '' {
    return RESOURCE_KINDS.find((entry) => entry.kind === value)?.kind ?? '';
  }

  function search(event: SubmitEvent): void {
    event.preventDefault();
    router.navigate(
      pathOf({
        since: since ?? '',
        type: typeChoice === OTHER_TYPE ? otherType : typeChoice,
        resource: joinResource({ kind: resourceKind, id: resourceId }),
      }),
      { replace: true },
    );
  }

  function clear(): void {
    since = undefined;
    typeChoice = EMPTY_AUDIT_DRAFT.type;
    otherType = '';
    resourceKind = '';
    resourceId = '';
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
      placeholder={AUDIT_COPY.sincePlaceholder}
      granularity="minute"
      bind:value={since}
    />
    <Select
      id="weft-audit-type"
      label={AUDIT_COPY.typeLabel}
      labelVisible={false}
      class="weft-audit__identifier"
      options={typeOptions}
      value={typeChoice}
      onchange={(event) => (typeChoice = event.currentTarget.value)}
    />
    {#if typeChoice === OTHER_TYPE}
      <Input
        id="weft-audit-type-other"
        label={AUDIT_COPY.otherTypeLabel}
        labelVisible={false}
        placeholder={AUDIT_COPY.otherTypePlaceholder}
        bind:value={otherType}
      />
    {/if}
    <Select
      id="weft-audit-resource-kind"
      label={AUDIT_COPY.resourceLabel}
      labelVisible={false}
      options={kindOptions}
      value={resourceKind}
      onchange={(event) => (resourceKind = kindOf(event.currentTarget.value))}
    />
    {#if resourceKind !== ''}
      <Input
        id="weft-audit-resource"
        label={AUDIT_COPY.resourceIdLabel}
        labelVisible={false}
        placeholder={AUDIT_COPY.resourceIdPlaceholder}
        class="weft-audit__identifier"
        bind:value={resourceId}
      />
    {/if}
    <div class="weft-audit__actions">
      <Button type="submit" variant="primary" size="lg">{AUDIT_COPY.searchAction}</Button>
      <Button type="button" variant="secondary" size="lg" onclick={clear}
        >{AUDIT_COPY.clearAction}</Button
      >
    </div>
  </form>

  {#if trail.isError}
    <Alert variant="danger">
      <p class="weft-audit__alert-title">{AUDIT_COPY.failed.title}</p>
      <p class="weft-audit__alert-body">{AUDIT_COPY.failed.description}</p>
      <Button variant="secondary" size="lg" onclick={() => void trail.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if trail.isPending}
    <p role="status" aria-busy="true" class="weft-audit__muted">{VIEW_COPY.audit.loading.title}</p>
  {:else if records.length === 0}
    <EmptyState
      title={filtered ? AUDIT_COPY.noMatches.title : (VIEW_COPY.audit.empty?.title ?? '')}
      description={filtered
        ? AUDIT_COPY.noMatches.description
        : (VIEW_COPY.audit.empty?.description ?? '')}
    >
      {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <ol class="weft-audit__records" aria-label={AUDIT_COPY.caption}>
      {#each keyedByOccurrence(records, keyOf) as { key, item: record } (key)}
        <li class="weft-audit__item" data-record={record.sequence ?? ''}>
          {#snippet summary()}
            <span class="weft-audit__summary">
              <time class="weft-audit__time" datetime={record.timestamp}
                >{timeOf(record.timestamp)}</time
              >
              <code class="weft-audit__type">{record.type}</code>
              <code class="weft-audit__resource">{record.resource}</code>
              <span class="weft-audit__actor">{record.principal ?? AUDIT_COPY.noActor}</span>
              <span class="weft-audit__detail">{detailOf(record)}</span>
            </span>
          {/snippet}
          <Collapsible
            trigger={summary}
            class="weft-audit__record"
            triggerClass="weft-audit__record-trigger"
            animated={false}
          >
            <h2 class="weft-audit__raw-heading">{AUDIT_COPY.rawRecord}</h2>
            <CodeBlock
              code={JSON.stringify(record, null, 2)}
              language="json"
              highlight={false}
              copyable
            />
          </Collapsible>
        </li>
      {/each}
    </ol>
    {#if trail.hasNextPage}
      <div class="weft-audit__more">
        <Button
          variant="secondary"
          size="lg"
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
    gap: var(--cinder-space-4);
  }

  .weft-audit__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }

  /* One row of controls, all of one height and aligned on their bottom edge: only the time field
   * carries a label, since a select that starts at "Any type" and an id field with a placeholder
   * already say what they are. */
  .weft-audit__search {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: flex-end;
  }

  .weft-audit__search > :global(*) {
    flex: 0 1 14rem;
    min-width: 0;
  }

  .weft-audit__actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  :global(.weft-audit__identifier input),
  :global(.weft-audit__identifier select) {
    font-family: var(--cinder-font-mono);
  }

  .weft-audit__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-audit__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  .weft-audit__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-audit__raw-heading {
    margin: 0 0 var(--cinder-space-2);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-audit__more {
    display: flex;
    justify-content: center;
  }

  /* Flat rows: no box around a record, only the line under it. */
  .weft-audit__records {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .weft-audit__item {
    border-bottom: 1px solid var(--cinder-border-muted);
  }

  :global(.weft-audit__record) {
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  :global(.weft-audit__record-trigger) {
    padding-block: var(--cinder-space-2);
    padding-inline: 0;
    background: transparent;
  }

  /* One line where it fits: when, what, about what, by whom, and the detail, which is the one part
   * that gives way. At a phone's width the record wraps into two lines. */
  .weft-audit__summary {
    display: grid;
    grid-template-columns: 11rem 12rem minmax(0, 14rem) 9rem minmax(0, 1fr);
    gap: var(--cinder-space-3);
    align-items: baseline;
    font-size: var(--cinder-text-sm);
  }

  .weft-audit__time {
    white-space: nowrap;
  }

  .weft-audit__type,
  .weft-audit__resource {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-audit__actor {
    overflow-wrap: anywhere;
  }

  .weft-audit__detail {
    color: var(--cinder-text-subtle);
    font-size: var(--cinder-text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 63.99rem) {
    .weft-audit__summary {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }

    .weft-audit__detail {
      grid-column: 1 / -1;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
