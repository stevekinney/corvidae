<script lang="ts">
  /**
   * `/hooks`: the caller's hooks as one bordered table (`hook-table.svelte`): each read as a sentence
   * ("When Review requested, send a signed message to ..."), beside what it is limited to, when it
   * last sent something, and an On switch. The toolbar has the count, a search over the sentences,
   * filters by event and by agent, and New hook.
   *
   * The list carries each hook's newest delivery, so every hook sorts by it. A home that keeps hooks
   * off says so in place of the list (`hooks-unavailable.svelte`).
   */
  import { Alert, Button, EmptyState, FilterBar, PageHeader } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { listHooks } from '../../lib/bureau-hooks.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { eventWords, hookMatches } from './hook-presentation.ts';
  import HookTable from './hook-table.svelte';
  import HooksUnavailable from './hooks-unavailable.svelte';

  const NEW_HOOK_PATH = '/hooks/new';

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
  const filtered = $derived(
    search !== '' || eventFilter !== undefined || agentFilter !== undefined,
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
      options: eventKinds.map((kind) => ({ value: kind, label: eventWords(kind) })),
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
      : [
          {
            key: 'event',
            value: eventFilter,
            label: HOOKS_COPY.eventFilter,
          },
        ]),
    ...(agentFilter === undefined
      ? []
      : [
          {
            key: 'agent',
            value: agentFilter,
            label: HOOKS_COPY.agentFilter,
          },
        ]),
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

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if unavailable}
  <HooksUnavailable />
{:else}
  <section class="ib-hooks ib-records" aria-label={VIEW_COPY.hooks.label} data-page="hooks">
    <PageHeader title={VIEW_COPY.hooks.label} headingLevel={1} />

    {#snippet filterBar()}
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
        onClearAll={clearFilters}
      />
    {/snippet}
    {#snippet newHook()}
      <Button
        href={router.href(NEW_HOOK_PATH)}
        variant="primary"
        size="sm"
        onclick={(event) => go(event, NEW_HOOK_PATH)}>{HOOKS_COPY.newAction}</Button
      >
    {/snippet}
    <RecordsToolbar count={HOOKS_COPY.count(visible.length)} filters={filterBar} action={newHook} />

    {#if hooks.isError}
      <Alert variant="danger">
        <p class="ib-hooks__alert-title">{VIEW_COPY.hooks.error.title}</p>
        <p class="ib-hooks__alert-body">{VIEW_COPY.hooks.error.description}</p>
        <Button variant="secondary" size="sm" onclick={() => void hooks.refetch()}
          >{RETRY_LABEL}</Button
        >
      </Alert>
    {:else if rows.length > 0 && visible.length === 0 && filtered}
      <EmptyState
        kind="filtered"
        title={HOOKS_COPY.noMatch.title}
        description={HOOKS_COPY.noMatch.description}
        headingLevel={2}
        clearFiltersLabel={HOOKS_COPY.clearAction}
        onClearFilters={clearFilters}
      />
    {:else if visible.length > 0}
      <HookTable hooks={visible} />
    {/if}
  </section>
{/if}

<style>
  .ib-hooks__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-hooks__alert-body {
    margin: 4px 0 8px;
  }
</style>
