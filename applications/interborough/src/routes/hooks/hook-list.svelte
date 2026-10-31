<script lang="ts">
  /**
   * `/hooks`: the caller's hooks as one bordered table. A hook is read as a sentence ("When Review
   * requested, send a signed message to ..."), beside when it last sent something and an On switch
   * that turns it on or off. A hook whose last delivery failed comes first, so what needs looking at
   * is at the top. The toolbar has the count, a search over the sentences, a filter by event, and
   * New hook.
   *
   * The last delivery is one read per hook (`bureau.hooks.deliveries`), made for the first
   * `LAST_DELIVERY_READ_CAP` hooks the page holds; a hook past them shows that its delivery was
   * not read, and its failures do not sort it first. A home that keeps hooks off says so in place of
   * the list (`hooks-unavailable.svelte`).
   */
  import {
    Alert,
    Button,
    EmptyState,
    FilterBar,
    PageHeader,
    RelativeTime,
    Table,
  } from '@lostgradient/cinder';
  import {
    createMutation,
    createQueries,
    createQuery,
    useQueryClient,
  } from '@tanstack/svelte-query';

  import { RETRY_LABEL, STALE_COPY, VIEW_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { showFault } from '../../app/toast-host.svelte';
  import {
    listHookDeliveries,
    listHooks,
    updateHook,
    type Hook,
    type HookDelivery,
  } from '../../lib/bureau-hooks.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { classifyFault, faultTreatment } from '../../lib/faults.ts';
  import { hookPath } from '../../lib/identifier-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import { HOOKS_COPY } from './hook-copy.ts';
  import {
    deliveryFailed,
    deliveryLine,
    deliveryWord,
    eventWords,
    failingFirst,
    hookMatches,
    hookSentence,
    LAST_DELIVERY_READ_CAP,
  } from './hook-presentation.ts';
  import HooksUnavailable from './hooks-unavailable.svelte';

  const NEW_HOOK_PATH = '/hooks/new';

  const queryClient = useQueryClient();

  const hooks = createQuery(
    () => ({
      queryKey: queryKeys.hooks.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listHooks({ signal }),
      retry: false,
    }),
    undefined,
  );
  const rows = $derived(hooks.data ?? []);
  const unavailable = $derived(
    hooks.isError && classifyFault(hooks.error)?.kind === 'not-supported',
  );

  const readable = $derived(rows.slice(0, LAST_DELIVERY_READ_CAP));
  const lastReads = createQueries(() => ({
    queries: readable.map((hook) => ({
      queryKey: queryKeys.hooks.last(hook.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => listHookDeliveries(hook.id, 1, { signal }),
      retry: false,
    })),
  }));
  /** The newest delivery of each hook read: `null` when it has none, absent when it was not read. */
  const lastDeliveries = $derived.by(() => {
    const byHook = new Map<string, HookDelivery | null>();
    readable.forEach((hook, index) => {
      const read = lastReads[index];
      if (read?.isSuccess) byHook.set(hook.id, read.data[0] ?? null);
    });
    return byHook;
  });

  const search = $derived(router.current.search.get('q') ?? '');
  const eventFilter = $derived(router.current.search.get('event') ?? undefined);

  const visible = $derived(
    failingFirst(
      rows.filter(
        (hook) =>
          hookMatches(hook, search) &&
          (eventFilter === undefined || hook.events.includes(eventFilter)),
      ),
      (hook) => deliveryFailed(lastDeliveries.get(hook.id) ?? undefined),
    ),
  );
  const filtered = $derived(search !== '' || eventFilter !== undefined);

  const eventKinds = $derived(
    [
      ...new Set([...rows.flatMap((hook) => hook.events), ...(eventFilter ? [eventFilter] : [])]),
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
  ]);
  const appliedFilters = $derived(
    eventFilter === undefined
      ? []
      : [
          {
            key: 'event',
            value: eventFilter,
            label: `${HOOKS_COPY.eventFilter}: ${eventWords(eventFilter)}`,
          },
        ],
  );

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

  /** A hook the Bureau refused to change for being stale: nothing was changed, and the list was read again. */
  let staleHook = $state<string | null>(null);

  const switching = createMutation(() => ({
    mutationFn: (input: { hook: Hook; enabled: boolean }) =>
      updateHook(input.hook.id, input.hook.revision, { enabled: input.enabled }),
    onMutate: () => {
      staleHook = null;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hooks'] }),
    onError: (error: unknown, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks.list() });
      if (agentFaultOf(error).kind === 'stale') {
        staleHook = input.hook.id;
        return;
      }
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${HOOKS_COPY.toggleFailed}. ${treatment.message}` });
    },
  }));
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

    {#if staleHook !== null}
      <Alert variant="warning" dismissible onDismiss={() => (staleHook = null)}>
        <p class="ib-hooks__alert-title">{STALE_COPY.title(staleHook)}</p>
        <p class="ib-hooks__alert-body">{STALE_COPY.description}</p>
      </Alert>
    {/if}

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
      <Table caption={HOOKS_COPY.caption} density="condensed">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{HOOKS_COPY.hookColumn}</Table.HeaderCell>
            <Table.HeaderCell>{HOOKS_COPY.lastDeliveryColumn}</Table.HeaderCell>
            <Table.HeaderCell>{HOOKS_COPY.onColumn}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each keyedByOccurrence(visible, (hook) => hook.id) as { key, item: hook } (key)}
            {@const last = lastDeliveries.get(hook.id)}
            {@const sentence = hookSentence(hook)}
            <Table.Row data-hook={hook.id} data-enabled={hook.enabled ? 'true' : 'false'}>
              <Table.Cell class="ib-records__wrap">
                <a
                  class="ib-hooks__sentence"
                  href={router.href(hookPath(hook.id))}
                  onclick={(event) => go(event, hookPath(hook.id))}>{sentence}</a
                >
                {#if hook.name !== null}
                  <span class="ib-records__muted ib-hooks__name">{hook.name}</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="ib-records__wrap" data-last-delivery>
                {#if last === undefined}
                  <span class="ib-records__muted">{HOOKS_COPY.deliveryNotRead}</span>
                {:else if last === null}
                  <span class="ib-records__muted">{HOOKS_COPY.noDelivery}</span>
                {:else}
                  <StatusLabel word={deliveryWord(last.status)} />
                  <span class="ib-records__muted ib-hooks__line">{deliveryLine(last)}</span>
                  <RelativeTime date={last.updatedAt} class="ib-records__muted" />
                {/if}
              </Table.Cell>
              <Table.Cell>
                <Button
                  data-changes
                  role="switch"
                  aria-checked={hook.enabled}
                  aria-label={HOOKS_COPY.toggleLabel(sentence)}
                  variant={hook.enabled ? 'secondary' : 'ghost'}
                  size="sm"
                  disabled={switching.isPending}
                  onclick={() => switching.mutate({ hook, enabled: !hook.enabled })}
                  >{hook.enabled ? HOOKS_COPY.onState : HOOKS_COPY.offState}</Button
                >
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
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

  .ib-hooks__sentence {
    overflow-wrap: anywhere;
  }

  .ib-hooks__name,
  .ib-hooks__line {
    display: block;
    overflow-wrap: anywhere;
  }
</style>
