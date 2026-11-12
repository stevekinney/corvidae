<script lang="ts">
  /**
   * `/hooks`: the caller's hooks as Cinder's status-first two-line rows (`hook-rows.svelte`): a
   * status word beside the hook's name and when it last delivered, the hook as a sentence on line
   * two ("When a run fails, send a webhook to events.pagerduty.com"), and an On switch at the end.
   * One filter row has a search over the sentences, an event filter, an agent filter and the count.
   * The header's "+" makes a hook.
   *
   * The list carries each hook's newest delivery, so every hook sorts by it, a failing one first. A
   * home that keeps hooks off says so in place of the page (`hooks-unavailable.svelte`).
   *
   * The page keeps its header in every state, so it draws its own (`ownsStates` in `app/views.ts`):
   * nothing yet is an empty state that is the page, with no filter row and the one primary "New
   * hook"; filters that match nothing keep the filter row over a "Clear filters" state; a read in
   * progress shows placeholders after 300 ms, and after 10 s a status line with Cancel; a read that
   * failed with nothing to show is a full error state with the header's "+" inert; and one that
   * failed over hooks already on screen leaves them in place under the shared refresh-failed banner,
   * with filters and links live and every control that changes something (the "+", New hook and each
   * row's switch) held, described by why (`StaleRegion`). The frame still says whether the caller
   * may see the view at all.
   */
  import {
    Banner,
    Button,
    EmptyState,
    ErrorState,
    FilterBar,
    PageHeader,
    Skeleton,
    StaleRegion,
  } from '@lostgradient/cinder';
  import { Plus, Search, Webhook } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { CONNECTION_COPY, RETRY_LABEL } from '../../app/copy/views.ts';
  import { VIEW_COPY } from '../../app/copy/view-pages.ts';
  import { listHooks } from '../../lib/bureau-hooks.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { eventOptionLabel, hookListFailure, hookMatches } from './hook-presentation.ts';
  import HookRows from './hook-rows.svelte';
  import HooksUnavailable from './hooks-unavailable.svelte';

  const NEW_HOOK_PATH = '/hooks/new';
  /** How long a read is let to finish before anything is drawn for it, which is Cinder's loading rule. */
  const LOADING_DELAY_MILLISECONDS = 300;
  /** How long a read runs before the placeholders say it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;

  const copy = HOOKS_COPY.list;
  const queryClient = useQueryClient();
  const connection = getConnection();

  const hooks = createQuery(
    () => ({
      queryKey: queryKeys.hooks.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listHooks(undefined, { signal }),
      retry: false,
    }),
    undefined,
  );
  const rows = $derived(hooks.data ?? []);
  const unavailable = $derived(
    hooks.isError && classifyFault(hooks.error)?.kind === 'not-supported',
  );

  // A read that failed with nothing to show is the page's error; one that failed over hooks already
  // read leaves them in place under the refresh-failed banner. A server that gives no answer at all
  // is the shell's to say, in its own banner, so the page adds none.
  const failedFirstLoad = $derived(hooks.isError && hooks.data === undefined);
  const refreshFailed = $derived(
    hooks.isError && hooks.data !== undefined && !connection.unreachable,
  );
  // "Cancel" in the still-loading line stopped the first read, and "Try again" reads again.
  let loadStopped = $state(false);
  const stopped = $derived(hooks.isPending && loadStopped);
  const loading = $derived(hooks.isPending && !loadStopped);
  const nothingYet = $derived(!hooks.isPending && !hooks.isError && rows.length === 0);

  function stopLoading(): void {
    loadStopped = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.hooks.list() });
  }

  function readAgain(): void {
    loadStopped = false;
    void hooks.refetch();
  }

  /** Reads the list again, and the frame's own probe of it, so what the frame says follows. */
  function retry(): void {
    void hooks.refetch();
    void queryClient.refetchQueries({ queryKey: queryKeys.view('hooks', null) });
  }

  const search = $derived(router.current.search.get('q') ?? '');
  const eventFilter = $derived(router.current.search.get('event') ?? undefined);
  const agentFilter = $derived(router.current.search.get('agent') ?? undefined);

  const visible = $derived(
    rows.filter(
      (hook) =>
        hookMatches(hook, search) &&
        (eventFilter === undefined || hook.events.includes(eventFilter)) &&
        (agentFilter === undefined ||
          (hook.scope?.kind === 'agent' && hook.scope.id === agentFilter)),
    ),
  );

  const eventKinds = $derived(
    [
      ...new Set([...rows.flatMap((hook) => hook.events), ...(eventFilter ? [eventFilter] : [])]),
    ].toSorted(),
  );
  const agentNames = $derived(
    [
      ...new Set([
        ...rows.flatMap((hook) => (hook.scope?.kind === 'agent' ? [hook.scope.id] : [])),
        ...(agentFilter ? [agentFilter] : []),
      ]),
    ].toSorted(),
  );
  const facets = $derived([
    {
      type: 'select' as const,
      key: 'event',
      label: HOOKS_COPY.eventFilter,
      placeholder: HOOKS_COPY.anyEvent,
      options: eventKinds.map((kind) => ({ value: kind, label: eventOptionLabel(kind) })),
    },
    {
      type: 'select' as const,
      key: 'agent',
      label: HOOKS_COPY.agentFilter,
      placeholder: HOOKS_COPY.anyAgent,
      options: agentNames.map((name) => ({ value: name, label: name })),
    },
  ]);
  const appliedFilters = $derived([
    ...(eventFilter === undefined
      ? []
      : [{ key: 'event', value: eventFilter, label: HOOKS_COPY.eventFilter }]),
    ...(agentFilter === undefined
      ? []
      : [{ key: 'agent', value: agentFilter, label: HOOKS_COPY.agentFilter }]),
  ]);

  function setParameter(key: string, value: string): void {
    const params = new URLSearchParams(router.current.search);
    if (value === '') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.navigate(`/hooks${query === '' ? '' : `?${query}`}`, { replace: true });
  }

  function clearFilters(): void {
    router.navigate('/hooks', { replace: true });
  }

  /** The words of a held control: the connection's when the server does not answer, else the list's. */
  const heldReason = $derived(
    connection.unreachable ? CONNECTION_COPY.changesOff : copy.refreshOff,
  );
</script>

{#if unavailable}
  <HooksUnavailable />
{:else}
  <section class="ib-hooks ib-records" aria-label={VIEW_COPY.hooks.label} data-page="hooks">
    <!-- While the list on screen is old, the controls that change something are held, each described
         by why; the hooks keep full contrast, and filters, search, rows and links stay live. -->
    <StaleRegion stale={connection.unreachable || refreshFailed} reason={heldReason}>
      <PageHeader
        title={VIEW_COPY.hooks.label}
        description={nothingYet ? copy.subtitleShort : copy.subtitle}
        headingLevel={1}
        error={failedFirstLoad}
        createAction={{
          label: HOOKS_COPY.newAction,
          onclick: () => router.navigate(NEW_HOOK_PATH),
          ...(failedFirstLoad ? { inertReason: copy.newActionOffReason } : {}),
        }}
      />

      {#if refreshFailed}
        <Banner preset="refresh-failed" dataUpdatedAt={hooks.dataUpdatedAt} onRetry={retry} />
      {/if}

      {#if failedFirstLoad}
        <ErrorState
          bordered
          title={copy.loadFailed.title}
          description={hookListFailure(hooks.error)}
          headingLevel={2}
          retryLabel={RETRY_LABEL}
          onRetry={retry}
        >
          {#snippet secondaryAction()}
            <Button variant="secondary" href={router.href(copy.loadFailed.openHealthPath)}
              >{copy.loadFailed.openHealth}</Button
            >
          {/snippet}
        </ErrorState>
      {:else if stopped}
        <ErrorState
          bordered
          tone="neutral"
          title={copy.stopped.title}
          description={copy.stopped.description}
          headingLevel={2}
          retryLabel={RETRY_LABEL}
          retryVariant="secondary"
          onRetry={readAgain}
        />
      {:else if loading}
        <div data-testid="hooks-loading" aria-busy="true">
          <Skeleton
            variant="list"
            rows={4}
            statusMarker="dot"
            delay={LOADING_DELAY_MILLISECONDS}
            stillLoadingAfter={STILL_LOADING_MILLISECONDS}
            stillLoadingLabel={copy.stillLoading}
            label={copy.loading}
            onCancel={stopLoading}
          />
        </div>
      {:else if nothingYet}
        <EmptyState
          bordered
          kind="first-use"
          title={copy.firstUse.title}
          description={copy.firstUse.description}
          headingLevel={2}
        >
          {#snippet icon()}<Webhook aria-hidden="true" />{/snippet}
          {#snippet action()}
            <Button
              variant="primary"
              label={HOOKS_COPY.newAction}
              mutating
              onclick={() => router.navigate(NEW_HOOK_PATH)}
            >
              {#snippet leadingIcon()}<Plus />{/snippet}
            </Button>
          {/snippet}
        </EmptyState>
      {:else}
        <div class="ib-hooks__controls">
          <FilterBar
            aria-label={HOOKS_COPY.filtersLabel}
            searchQuery={search}
            searchPlaceholder={HOOKS_COPY.searchPlaceholder}
            searchAriaLabel={HOOKS_COPY.searchLabel}
            {facets}
            {appliedFilters}
            onSearchChange={(query) => setParameter('q', query)}
            onFacetChange={setParameter}
            onFilterRemove={(key) => setParameter(key, '')}
          />
          <p class="ib-hooks__count" role="status" data-testid="hooks-count">
            {HOOKS_COPY.count(visible.length)}
          </p>
        </div>

        {#if visible.length === 0}
          <EmptyState
            bordered
            kind="filtered"
            title={copy.noMatch.title}
            description={copy.noMatch.description(eventFilter !== undefined, search)}
            headingLevel={2}
            clearFiltersLabel={HOOKS_COPY.clearAction}
            onClearFilters={clearFilters}
          >
            {#snippet icon()}<Search aria-hidden="true" />{/snippet}
          </EmptyState>
        {:else}
          <HookRows hooks={visible} />
        {/if}
      {/if}
    </StaleRegion>
  </section>
{/if}

<style>
  .ib-hooks__controls {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hooks__controls > :global(:first-child) {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* The count sits at the right end of the filter row. */
  .ib-hooks__count {
    flex: none;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    white-space: nowrap;
  }
</style>
