<script lang="ts">
  /**
   * `/health/audit`: the audit log, searched by time, type, resource and who. The trail comes back
   * oldest first, as the Bureau returns it, as metadata only, and Load more follows the cursor the
   * Bureau hands back. The address owns the filters (`audit-filter.ts`), so a search can be linked
   * to, and a filter that is set stays set while the next page loads.
   *
   * The records are a list with the open one beside it: who, what and when on each line, and the
   * record, with a link to the thing it is about, in the pane. The Bureau takes no actor, so Who
   * narrows the records already loaded, and the Export button reads the whole trail the filters
   * match and saves it as JSON Lines.
   *
   * Nothing here asks for a syntax. Since is a date-time picker. Type is a select of the types the
   * trail has shown (the first page of the whole trail, and every page loaded since), with the one
   * the address names, and Other for a type it has not shown yet. The resource is a kind (Chat,
   * Agent, Schedule, Workflow, or a run id) and an id, and the `kind:<id>` string is built from them
   * (`splitResource` and `joinResource`), so no one types `schedule:`.
   *
   * The Bureau shows each caller the records about what it owns, so the page holds no scope of its
   * own: owner scoping is the gate. Whether the trail is empty, failing, or refused is the view
   * frame's to say (`app/view-probes.ts`), and this page speaks only for a search that fails after
   * the view opened, and for one that matches nothing.
   */
  import {
    Alert,
    Button,
    DatePicker,
    EmptyState,
    Input,
    ListDetail,
    PageHeader,
    SelectableRow,
    Select,
    Skeleton,
  } from '@lostgradient/cinder';
  import { Download } from '@lucide/svelte';
  import { createInfiniteQuery, createMutation, createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { AUDIT_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { queryAudit, type AuditRecord } from '../../lib/bureau-audit.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import AuditDetail from './audit-detail.svelte';
  import {
    auditExportFilename,
    downloadText,
    JSON_LINES_TYPE,
    readAuditExport,
    toJsonLines,
  } from './audit-export.ts';
  import {
    byWho,
    draftFromSearch,
    EMPTY_AUDIT_DRAFT,
    filterOf,
    joinResource,
    pathOf,
    RESOURCE_KINDS,
    splitResource,
    type ResourceKind,
  } from './audit-filter.ts';

  const copy = AUDIT_COPY;

  /** The Type select's value for "a type that is not in the list", which brings a field to type it in. */
  const OTHER_TYPE = '__other__';

  /** How many pages an address that names a record reads, looking for it. */
  const RECORD_SEARCH_PAGES = 20;

  // The filters the address holds are the ones the trail is asked with.
  const applied = $derived(draftFromSearch(router.current.search));
  const filter = $derived(filterOf(applied));
  const filtered = $derived(Object.keys(filter).length > 0 || applied.who.trim() !== '');

  // The form starts from the address, and is the person's until they search.
  // The date picker clears its value to `undefined`.
  let since = $state<string | undefined>(untrack(() => applied.since || undefined));
  let typeChoice = $state(untrack(() => applied.type.trim()));
  let otherType = $state('');
  let resourceKind = $state<ResourceKind | ''>(untrack(() => splitResource(applied.resource).kind));
  let resourceId = $state(untrack(() => splitResource(applied.resource).id));
  let who = $state(untrack(() => applied.who.trim()));

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

  // The types and the people the trail has shown: its first page, whatever was searched, and any
  // page loaded since. A search that narrows the trail still offers everything the first page had.
  const wholeTrail = createQuery(
    () => ({
      queryKey: queryKeys.audit.types(),
      queryFn: ({ signal }) => queryAudit({}, undefined, { limit: 100, signal }),
      retry: false,
      staleTime: 60_000,
    }),
    undefined,
  );

  const loaded = $derived((trail.data?.pages ?? []).flatMap((page) => page.records));
  const records = $derived(byWho(loaded, applied.who));
  const rows = $derived(
    keyedByOccurrence(records, keyOf).map(({ key, item }) => ({ key, record: item })),
  );
  type Row = (typeof rows)[number];

  // An address that names a record (`?record=`) opens it, even when it is on a later page: the list
  // resolves its selection against the rows it holds, so read pages until the record is among them
  // or the trail has no more.
  // The read stops after `RECORD_SEARCH_PAGES` pages, so a link to a record that is gone, or far
  // back, cannot read the whole trail; the page then says so and Load more continues by hand.
  const wantedRecord = $derived(router.current.search.get('record'));
  const searchedPages = $derived(trail.data?.pages.length ?? 0);
  const recordMissing = $derived(
    wantedRecord !== null &&
      !trail.isPending &&
      !trail.isError &&
      !trail.isFetchingNextPage &&
      !rows.some((row) => row.key === wantedRecord),
  );
  $effect(() => {
    if (!recordMissing || !trail.hasNextPage) return;
    if (searchedPages >= RECORD_SEARCH_PAGES) return;
    void trail.fetchNextPage();
  });

  const seen = $derived([...(wholeTrail.data?.records ?? []), ...loaded]);

  const typeOptions = $derived.by(() => {
    const types = new Set<string>(seen.map((record) => record.type));
    if (applied.type.trim() !== '') types.add(applied.type.trim());
    return [
      { value: '', label: copy.anyType },
      ...[...types].toSorted().map((type) => ({ value: type, label: type })),
      { value: OTHER_TYPE, label: copy.otherType },
    ];
  });

  const whoOptions = $derived.by(() => {
    const people = new Set<string>();
    for (const record of seen) if (record.principal !== null) people.add(record.principal);
    if (applied.who.trim() !== '') people.add(applied.who.trim());
    return [
      { value: '', label: copy.anyone },
      ...[...people].toSorted().map((person) => ({ value: person, label: person })),
    ];
  });

  const kindOptions = [
    { value: '', label: copy.anyResource },
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
        who,
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
    who = '';
    router.navigate(pathOf(EMPTY_AUDIT_DRAFT), { replace: true });
  }

  /** The record's own key: its time and its place in the trail's order within that time. */
  function keyOf(record: AuditRecord): string {
    return `${record.timestamp}#${String(record.sequence ?? '')}`;
  }

  function timeOf(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
  }

  const selectionLocation = routerSelectionLocationFor('/health/audit');

  // Export reads every page the filters match, not only the ones the list has loaded.
  const exportMutation = createMutation<number, unknown, void>(
    () => ({
      mutationFn: async () => {
        const matched = await readAuditExport(filter, applied.who);
        if (matched.length === 0) return 0;
        downloadText(toJsonLines(matched), auditExportFilename(), JSON_LINES_TYPE);
        return matched.length;
      },
      onSuccess: (count) =>
        showToast(count === 0 ? copy.nothingToExport : copy.exported(count), {
          variant: count === 0 ? 'info' : 'success',
        }),
    }),
    undefined,
  );
</script>

<section class="ib-audit" aria-label={VIEW_COPY.audit.label} data-page="audit">
  <PageHeader title={VIEW_COPY.audit.label} description={copy.description}>
    {#snippet actions()}
      <Button
        variant="secondary"
        loading={exportMutation.isPending}
        onclick={() => exportMutation.mutate()}
      >
        {#snippet leadingIcon()}<Download aria-hidden="true" size={14} />{/snippet}
        {exportMutation.isPending ? copy.exporting : copy.exportAction}
      </Button>
    {/snippet}
  </PageHeader>

  {#if exportMutation.isError}
    <Alert variant="danger">
      <p class="ib-audit__alert-title">{copy.exportFailed.title}</p>
      <p class="ib-audit__alert-body">{copy.exportFailed.description}</p>
      <Button variant="secondary" onclick={() => exportMutation.mutate()}>{RETRY_LABEL}</Button>
    </Alert>
  {/if}

  <form class="ib-audit__search" role="search" aria-label={copy.searchLabel} onsubmit={search}>
    <DatePicker
      id="ib-audit-since"
      label={copy.sinceLabel}
      labelVisible={false}
      placeholder={copy.sincePlaceholder}
      granularity="minute"
      bind:value={since}
    />
    <Select
      id="ib-audit-type"
      label={copy.typeLabel}
      labelVisible={false}
      class="ib-audit__identifier"
      options={typeOptions}
      value={typeChoice}
      onchange={(event) => (typeChoice = event.currentTarget.value)}
    />
    {#if typeChoice === OTHER_TYPE}
      <Input
        id="ib-audit-type-other"
        label={copy.otherTypeLabel}
        labelVisible={false}
        placeholder={copy.otherTypePlaceholder}
        bind:value={otherType}
      />
    {/if}
    <Select
      id="ib-audit-who"
      label={copy.whoLabel}
      labelVisible={false}
      options={whoOptions}
      value={who}
      onchange={(event) => (who = event.currentTarget.value)}
    />
    <Select
      id="ib-audit-resource-kind"
      label={copy.resourceLabel}
      labelVisible={false}
      options={kindOptions}
      value={resourceKind}
      onchange={(event) => (resourceKind = kindOf(event.currentTarget.value))}
    />
    {#if resourceKind !== ''}
      <Input
        id="ib-audit-resource"
        label={copy.resourceIdLabel}
        labelVisible={false}
        placeholder={copy.resourceIdPlaceholder}
        class="ib-audit__identifier"
        bind:value={resourceId}
      />
    {/if}
    <div class="ib-audit__actions">
      <Button type="submit" variant="primary">{copy.searchAction}</Button>
      <Button type="button" variant="secondary" onclick={clear}>{copy.clearAction}</Button>
    </div>
  </form>

  {#if recordMissing && (!trail.hasNextPage || searchedPages >= RECORD_SEARCH_PAGES)}
    <Alert variant="info">
      <p class="ib-audit__alert-body">
        {trail.hasNextPage ? copy.recordNotFound.more : copy.recordNotFound.end}
      </p>
    </Alert>
  {/if}

  {#if trail.isError}
    <Alert variant="danger">
      <p class="ib-audit__alert-title">{copy.failed.title}</p>
      <p class="ib-audit__alert-body">{copy.failed.description}</p>
      <Button variant="secondary" onclick={() => void trail.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if trail.isPending}
    <div role="status" aria-busy="true" aria-label={copy.loadingLabel}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if rows.length === 0 && !trail.hasNextPage}
    {#if filtered}
      <EmptyState
        kind="filtered"
        headingLevel={2}
        title={copy.noMatches.title}
        description={copy.noMatches.description}
        clearFiltersLabel={copy.noMatches.clear}
        onClearFilters={clear}
      />
    {:else}
      <EmptyState
        kind="first-use"
        headingLevel={2}
        title={VIEW_COPY.audit.empty?.title ?? ''}
        description={VIEW_COPY.audit.empty?.description ?? ''}
      />
    {/if}
  {:else}
    <div class="ib-audit__frame" data-shortcut-region="list-detail">
      <ListDetail
        items={rows}
        key={(row: Row) => row.key}
        label={copy.caption}
        detailLabel={copy.detailLabel}
        emptyTitle={copy.emptyDetailTitle}
        emptyDescription={copy.emptyDetailDescription}
        selectionParameter="record"
        {selectionLocation}
        storageKey="interborough-audit"
      >
        {#snippet header()}
          <div class="ib-audit__list-bar">
            <p class="ib-audit__count" data-testid="audit-count">
              {copy.count(rows.length, trail.hasNextPage)}
            </p>
            {#if trail.hasNextPage}
              <Button
                variant="secondary"
                size="sm"
                disabled={trail.isFetchingNextPage}
                onclick={() => void trail.fetchNextPage()}>{copy.loadMore}</Button
              >
            {/if}
          </div>
        {/snippet}
        {#snippet list(row, state)}
          <SelectableRow
            selected={state.selected}
            selectedState="current"
            onclick={state.open}
            data-record={row.record.sequence ?? ''}
          >
            {#snippet title()}<span class="ib-audit__type">{row.record.type}</span>{/snippet}
            {#snippet description()}
              <span class="ib-audit__who">{row.record.principal ?? copy.noActor}</span>
              <span class="ib-audit__resource">{row.record.resource}</span>
            {/snippet}
            {#snippet meta()}
              <time datetime={row.record.timestamp}>{timeOf(row.record.timestamp)}</time>
            {/snippet}
          </SelectableRow>
        {/snippet}
        {#snippet listEmpty()}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={3}
            title={copy.noLoadedMatches.title}
            description={copy.noLoadedMatches.description}
            clearFiltersLabel={copy.noLoadedMatches.clear}
            onClearFilters={clear}
          />
        {/snippet}
        {#snippet detail(row)}
          <AuditDetail record={row.record} />
        {/snippet}
      </ListDetail>
    </div>
  {/if}
</section>

<style>
  .ib-audit {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  /* One row of controls, all of one height and aligned on their bottom edge: only the time field
   * carries a label, since a select that starts at "Any type" and an id field with a placeholder
   * already say what they are. */
  .ib-audit__search {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: flex-end;
  }

  .ib-audit__search > :global(*) {
    flex: 0 1 12rem;
    min-width: 0;
  }

  .ib-audit__actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  :global(.ib-audit__identifier input),
  :global(.ib-audit__identifier select) {
    font-family: var(--cinder-font-mono);
  }

  .ib-audit__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-audit__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  /* ListDetail fills the height it is given and scrolls each pane, so the frame gives it one. */
  .ib-audit__frame {
    block-size: max(28rem, calc(100dvh - 20rem));
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-audit__list-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .ib-audit__count {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-audit__type,
  .ib-audit__resource {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-audit__who {
    margin-inline-end: var(--cinder-space-2);
    overflow-wrap: anywhere;
  }
</style>
