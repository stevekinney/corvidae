<script lang="ts">
  /**
   * `/health/audit`: the audit log, who did what and when, newest first. One row of filters (who,
   * period, action, a search box and the count of events) with Export at its right end, and below
   * it a table of events (When, Who, What, Target) under a heading for each day, with the open event
   * beside it. The newest event is open when the page loads, and a row opens any other.
   *
   * The records the Bureau keeps are metadata only, and most of them are a run's own steps, so the
   * log lists the ones that are events (`lib/audit-event-types.ts`) and words each one
   * (`audit-events.ts`, with what the page looks up for it, `audit-lookups.svelte.ts`). The period
   * and the action reach the Bureau, which pages through and counts only those; Who and the search
   * narrow the events already read, so while either is set the page keeps reading pages until the
   * log is read or a bound is reached. The address owns the filters (`audit-filter.ts`) and the open
   * event (`?record=`), so a search can be linked to. Export saves what the filters match, as JSON
   * Lines.
   *
   * The Bureau shows each caller the records about what it owns, so the page holds no scope of its
   * own: owner scoping is the gate. Whether the log is empty, failing, or refused is the view
   * frame's to say (`app/view-probes.ts`), and this page speaks only for a read that fails after
   * the view opened, and for filters that match nothing.
   */
  import {
    Alert,
    Button,
    DataTable,
    EmptyState,
    ListDetail,
    SearchField,
    Select,
    Skeleton,
  } from '@lostgradient/cinder';
  import type { DataTableColumn } from '@lostgradient/cinder';
  import { Download, FileText } from '@lucide/svelte';
  import { createInfiniteQuery, createMutation, createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { AUDIT_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { AUDIT_ACTION_KINDS } from '../../lib/audit-event-types.ts';
  import { queryAudit } from '../../lib/bureau-audit.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import HealthFrame from '../health/health-frame.svelte';
  import AuditDetail from './audit-detail.svelte';
  import {
    auditExportFilename,
    downloadText,
    JSON_LINES_TYPE,
    readAuditExport,
    toJsonLines,
  } from './audit-export.ts';
  import {
    clockOf,
    dayGroupOf,
    describeRecords,
    narrowEvents,
    NO_LOOKUPS,
    recordKey,
    type AuditEvent,
  } from './audit-events.ts';
  import {
    AUDIT_ACTORS,
    AUDIT_PERIODS,
    draftFromSearch,
    filterOf,
    isNarrowed,
    pathOf,
    type AuditDraft,
  } from './audit-filter.ts';
  import { useAuditLookups } from './audit-lookups.svelte.ts';

  const copy = AUDIT_COPY;

  /** How long a read runs before the skeleton is drawn, so a quick read never flashes one. */
  const LOADING_DELAY_MILLISECONDS = 300;

  /** How long a read runs before the skeleton says it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;

  /** How many pages an address that names an event reads, looking for it. */
  const RECORD_SEARCH_PAGES = 20;

  /** How many pages a Who choice or a search reads on its own, looking for what it narrows to. */
  const NARROWING_PAGES = 20;

  /** The width of the log below which the table and an event's pane show one at a time. */
  const PUSH_BELOW = 600;

  /** How wide the table's pane starts, in pixels, before the divider is moved. */
  const LIST_PANE_WIDTH = 640;

  /** The widest the divider gives the table's pane, in pixels: its four columns need more than a list of rows. */
  const LIST_PANE_MAXIMUM_WIDTH = 1000;

  /** The widest the Target column grows before it ends a value with an ellipsis, so the row stays one line tall. */
  const TARGET_COLUMN_WIDTH = 220;

  // The filters the address holds are the ones the log is read with.
  const applied = $derived(draftFromSearch(router.current.search));
  // The reference time, read once: "Today" and the start of the period are as of when the page opened.
  const now = Date.now();
  const filter = $derived(filterOf(applied, now));
  const narrowing = $derived(applied.actor !== '' || applied.text.trim() !== '');

  let selectedKey = $state<string | null>(null);
  // The box the table and the pane share, measured when the newest event is opened.
  let frame = $state<HTMLElement>();

  // The search box is the person's until the address catches up with it.
  let text = $state(untrack(() => applied.text));

  function go(next: Partial<AuditDraft>): void {
    // Different filters list different events, so none is open until one is chosen.
    selectedKey = null;
    router.navigate(pathOf({ ...applied, ...next }), { replace: true });
  }

  $effect(() => {
    if (text !== untrack(() => applied.text)) go({ text });
  });

  const trail = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.audit.list(filter),
      queryFn: ({ pageParam, signal }) =>
        queryAudit(filter, pageParam === '' ? undefined : pageParam, {
          order: 'newest',
          signal,
        }),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      retry: false,
    }),
    undefined,
  );

  // How many events the period and the action match: read once, beside the first page.
  const totalQuery = createQuery(
    () => ({
      queryKey: queryKeys.audit.total(filter),
      queryFn: async ({ signal }) => {
        const counted = await queryAudit(filter, undefined, {
          limit: 1,
          includeTotal: true,
          signal,
        });
        return counted.total ?? null;
      },
      retry: false,
      staleTime: 30_000,
    }),
    undefined,
  );

  const loaded = $derived(
    combinePages(
      trail.data?.pages ?? [],
      (page) => page.records,
      (record) => recordKey(record),
    ),
  );
  const lookups = useAuditLookups(() => loaded);
  const allEvents = $derived(describeRecords(loaded, lookups.current));
  const events = $derived(narrowEvents(allEvents, applied.actor, applied.text));
  const searchedPages = $derived(trail.data?.pages.length ?? 0);

  // While Who or the search is set, read on until the log is read or a bound is reached, so what
  // they narrow to is not only what the first page held.
  $effect(() => {
    if (!narrowing || !trail.hasNextPage || trail.isFetchingNextPage) return;
    if (searchedPages >= NARROWING_PAGES) return;
    void trail.fetchNextPage();
  });

  // An address that names an event (`?record=`) opens it, even when it is on a later page.
  const wantedRecord = $derived(router.current.search.get('record'));
  const recordMissing = $derived(
    wantedRecord !== null &&
      !trail.isPending &&
      !trail.isError &&
      !trail.isFetchingNextPage &&
      !events.some((event) => event.key === wantedRecord),
  );
  $effect(() => {
    if (!recordMissing || !trail.hasNextPage || searchedPages >= RECORD_SEARCH_PAGES) return;
    void trail.fetchNextPage();
  });

  const actorOptions = [
    { value: '', label: copy.anyone },
    ...AUDIT_ACTORS.map((actor) => ({ value: actor, label: copy.actors[actor] })),
  ];
  const periodOptions = AUDIT_PERIODS.map((period) => ({
    value: period,
    label: copy.periods[period],
  }));
  const actionOptions = [
    { value: '', label: copy.anyAction },
    ...AUDIT_ACTION_KINDS.map((kind) => ({ value: kind, label: copy.actions[kind] })),
  ];

  /** The count beside the search: what the filters match, as far as it is known. */
  const count = $derived(
    narrowing || totalQuery.data == null || !trail.hasNextPage
      ? copy.count(events.length, trail.hasNextPage)
      : copy.count(totalQuery.data, false),
  );

  function clear(): void {
    selectedKey = null;
    text = '';
    router.navigate(pathOf({ actor: '', period: '7d', action: '', text: '' }), { replace: true });
  }

  type EventRow = {
    id: string;
    at: number;
    when: string;
    who: string;
    what: string;
    target: string;
  };

  const rows = $derived<EventRow[]>(
    events.map((event) => ({
      id: event.key,
      at: event.at,
      when: clockOf(event.at),
      who: event.actor.name,
      what: event.action,
      target: event.target,
    })),
  );
  const columns: DataTableColumn<EventRow>[] = [
    { key: 'when', label: copy.columns.when },
    { key: 'who', label: copy.columns.who },
    { key: 'what', label: copy.columns.what },
    { key: 'target', label: copy.columns.target, truncate: true, maxWidth: TARGET_COLUMN_WIDTH },
  ];

  // The newest event is open when the log first shows, and no event is after the filters change.
  let opened = false;
  $effect(() => {
    if (opened || trail.isPending || frame === undefined) return;
    opened = true;
    // Below the push breakpoint an open event would hide the table, so none opens on load there. A
    // box that has no width yet (a page with no layout) is read as wide, as the list reads it.
    const width = frame.getBoundingClientRect().width;
    if (width > 0 && width < PUSH_BELOW) return;
    if (untrack(() => router.current.search.get('record')) !== null) return;
    const newest = untrack(() => events[0]);
    if (newest !== undefined) selectedKey = newest.key;
  });

  const selectionLocation = routerSelectionLocationFor('/health/audit');

  // Export reads every page the filters match, not only the ones the table has loaded. While Who or
  // the search narrows the log, it saves the events on screen, which the page has read in full.
  const exportMutation = createMutation<number, unknown, void>(
    () => ({
      mutationFn: async () => {
        const read = narrowing ? undefined : await readAuditExport(filter);
        const matched =
          read === undefined
            ? events.map((event) => event.record)
            : read.filter((record) => describeRecords([record], NO_LOOKUPS).length > 0);
        if (matched.length === 0) return 0;
        downloadText(toJsonLines(matched), auditExportFilename(), JSON_LINES_TYPE);
        return matched.length;
      },
      onSuccess: (exported) =>
        showToast(exported === 0 ? copy.nothingToExport : copy.exported(exported), {
          variant: exported === 0 ? 'info' : 'success',
        }),
    }),
    undefined,
  );
</script>

<HealthFrame active="audit">
  <section class="ib-audit" aria-label={VIEW_COPY.audit.label} data-page="audit">
    <div class="ib-audit__controls">
      <form
        class="ib-audit__filters"
        role="search"
        aria-label={copy.searchLabel}
        onsubmit={(event) => event.preventDefault()}
      >
        <Select
          id="ib-audit-actor"
          label={copy.actorLabel}
          labelVisible={false}
          class="ib-audit__select"
          options={actorOptions}
          value={applied.actor}
          onchange={(event) => go({ actor: event.currentTarget.value as AuditDraft['actor'] })}
        />
        <Select
          id="ib-audit-period"
          label={copy.periodLabel}
          labelVisible={false}
          class="ib-audit__select"
          options={periodOptions}
          value={applied.period}
          onchange={(event) => go({ period: event.currentTarget.value as AuditDraft['period'] })}
        />
        <Select
          id="ib-audit-action"
          label={copy.actionLabel}
          labelVisible={false}
          class="ib-audit__select"
          options={actionOptions}
          value={applied.action}
          onchange={(event) => go({ action: event.currentTarget.value as AuditDraft['action'] })}
        />
        <SearchField
          aria-label={copy.textLabel}
          placeholder={copy.textPlaceholder}
          class="ib-audit__search"
          bind:value={text}
          onClear={() => (text = '')}
        />
        <p class="ib-audit__count" data-testid="audit-count">{count}</p>
      </form>
      <div class="ib-audit__export">
        <Button
          variant="secondary"
          loading={exportMutation.isPending}
          onclick={() => exportMutation.mutate()}
        >
          {#snippet leadingIcon()}<Download aria-hidden="true" size={14} />{/snippet}
          {exportMutation.isPending ? copy.exporting : copy.exportAction}
        </Button>
      </div>
    </div>

    {#if exportMutation.isError}
      <Alert variant="danger">
        <p class="ib-audit__alert-title">{copy.exportFailed.title}</p>
        <p class="ib-audit__alert-body">{copy.exportFailed.description}</p>
        <Button variant="secondary" onclick={() => exportMutation.mutate()}>{RETRY_LABEL}</Button>
      </Alert>
    {/if}

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
      <div data-testid="audit-loading" aria-busy="true">
        <Skeleton
          variant="list"
          rows={5}
          statusMarker="dot"
          statusColumn={false}
          delay={LOADING_DELAY_MILLISECONDS}
          stillLoadingAfter={STILL_LOADING_MILLISECONDS}
          label={copy.loadingLabel}
          onCancel={() => void trail.refetch()}
        />
      </div>
    {:else if events.length === 0 && !trail.hasNextPage}
      {#if isNarrowed(applied)}
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
      <div class="ib-audit__frame" data-shortcut-region="list-detail" bind:this={frame}>
        <ListDetail
          items={events}
          key={(event: AuditEvent) => event.key}
          label={copy.caption}
          detailLabel={copy.detailLabel}
          selectionParameter="record"
          {selectionLocation}
          bind:selectedKey
          pushBelow={PUSH_BELOW}
          storageKey="interborough-audit"
          defaultListWidth={LIST_PANE_WIDTH}
          maximumListWidth={LIST_PANE_MAXIMUM_WIDTH}
          class="ib-audit__layout"
        >
          {#snippet listBody(body)}
            <DataTable
              {columns}
              {rows}
              caption={copy.caption}
              density="condensed"
              class="ib-audit__table"
              getRowId={(row) => row.id}
              groupBy={(row) => dayGroupOf(row.at, now)}
              openRowId={body.selectedKey}
              onRowOpen={(row) => body.open(row.id)}
              onReachEnd={trail.hasNextPage && !narrowing
                ? () => void trail.fetchNextPage()
                : undefined}
            >
              {#snippet cell({ column, value })}
                {#if column.key === 'what'}
                  <span class="ib-audit__what">{value}</span>
                {:else}
                  {value}
                {/if}
              {/snippet}
              {#snippet footer()}
                <span class="ib-audit__footer" data-testid="audit-footer">
                  {copy.footer(events.length, totalQuery.data ?? undefined, trail.hasNextPage)}
                </span>
              {/snippet}
            </DataTable>
          {/snippet}
          {#snippet detail(event)}
            {#key event.key}
              <AuditDetail {event} lookups={lookups.current} {now} />
            {/key}
          {/snippet}
          {#snippet empty()}
            <EmptyState
              kind="first-use"
              size="compact"
              headingLevel={2}
              title={copy.emptyDetailTitle}
              description={copy.emptyDetailDescription}
            >
              {#snippet icon()}<FileText aria-hidden="true" />{/snippet}
            </EmptyState>
          {/snippet}
        </ListDetail>
      </div>
    {/if}
  </section>
</HealthFrame>

<style>
  .ib-audit {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
    container-type: inline-size;
  }

  /* One row of controls, with Export at its right end because it applies to this tab only. */
  .ib-audit__controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
    justify-content: space-between;
  }

  .ib-audit__filters {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
    min-width: 0;
  }

  .ib-audit__filters > :global(.ib-audit__select) {
    flex: 0 1 11rem;
    min-width: 0;
  }

  .ib-audit__filters > :global(.ib-audit__search) {
    flex: 0 1 18rem;
    min-width: 0;
  }

  .ib-audit__count {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    white-space: nowrap;
  }

  .ib-audit__export {
    display: flex;
    justify-content: flex-end;
  }

  /* On a narrow page each control takes its own row. */
  @container (max-width: 39.99rem) {
    .ib-audit__filters > :global(.ib-audit__select),
    .ib-audit__filters > :global(.ib-audit__search) {
      flex: 1 1 100%;
    }
  }

  .ib-audit__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-audit__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  /* The table and the open event, Cinder's list and detail, in one bordered box. Side by side the
   * two fill the height they are given and scroll each pane on its own, so the box has one; below
   * the push breakpoint they show one at a time and flow with the page. */
  .ib-audit__frame {
    min-inline-size: 0;
  }

  .ib-audit__frame :global(.ib-audit__layout) {
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-audit__frame :global(.ib-audit__layout[data-cinder-layout='split']) {
    block-size: max(28rem, calc(100dvh - 20rem));
  }

  .ib-audit__what {
    font-weight: 600;
    white-space: nowrap;
  }

  .ib-audit__footer {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
