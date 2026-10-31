<script module lang="ts">
  export const DYNAMIC_SOURCE_LIST_LIMIT = 10;

  type SourceLoadState = 'idle' | 'loading' | 'ready' | 'failed' | 'cancelled';

  export type CatalogSourceListEntry = {
    readonly name: string;
    readonly revision: string;
    readonly kind: 'module';
    readonly state: SourceLoadState;
  };

  type CatalogSourceListPage = {
    readonly sources: readonly CatalogSourceListEntry[];
    readonly nextOffset?: number;
  };

  function isCatalogSourceListEntry(value: unknown): value is CatalogSourceListEntry {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record['name'] === 'string' &&
      typeof record['revision'] === 'string' &&
      record['kind'] === 'module' &&
      typeof record['state'] === 'string' &&
      ['idle', 'loading', 'ready', 'failed', 'cancelled'].includes(record['state'])
    );
  }

  export function isCatalogSourceListPage(
    value: unknown,
    requestedOffset: number,
  ): value is CatalogSourceListPage {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record['sources']) || !record['sources'].every(isCatalogSourceListEntry)) {
      return false;
    }
    if (record['nextOffset'] === undefined) return true;
    return (
      typeof record['nextOffset'] === 'number' &&
      Number.isSafeInteger(record['nextOffset']) &&
      record['nextOffset'] >= 0 &&
      record['nextOffset'] > requestedOffset
    );
  }
</script>

<script lang="ts">
  /**
   * Paginated source picker for the Workflow sources panel. It reads
   * `weft.catalog.sources.list`, which is process-local source runtime state:
   * enough to select an exact `(name, revision)` key, never a substitute for
   * the per-key diagnostics/preload calls below it.
   */
  import { Badge, Button, EmptyState, SectionHeading, Skeleton, Table } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { DatabaseZap } from '@lucide/svelte';

  import { API_REFERENCE_COPY } from '../../app/copy.ts';
  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore, isForbidden, isUnauthorized } from '../../lib/scopes.svelte.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import { ACTIVE_SOURCE_POLL_MS, SETTLED_SOURCE_POLL_MS } from './source-load-diagnostics-view.ts';

  type Props = {
    readonly selectedKey: { readonly name: string; readonly revision: string } | null;
    readonly onSelect: (source: CatalogSourceListEntry) => void;
  };

  let { selectedKey, onSelect }: Props = $props();

  const client = getClient();
  const principal = getPrincipalStore();

  let offset = $state(0);

  const canRead = $derived(principal.hasScope('system:read'));

  // `workflow-source:load-*` and `catalog:revision-*` ask for the list again; the timer below runs
  // only while the fleet feed is not live.
  const fleetLive = useFleetEventsLive();

  const sourcesQuery = createQuery(() => {
    const pagination = { limit: DYNAMIC_SOURCE_LIST_LIMIT, offset };
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.catalog.sources(pagination),
      queryFn: async (): Promise<CatalogSourceListPage> => {
        try {
          const response = await client.operations['weft.catalog.sources.list'](pagination);
          if (!isCatalogSourceListPage(response, pagination.offset)) {
            throw new Error('The server returned a source list this console does not recognize.');
          }
          return response;
        } catch (error) {
          if (isUnauthorized(error)) principal.clear();
          else if (isForbidden(error)) principal.denyScope('system:read');
          throw error;
        }
      },
      enabled: canRead,
      // Other operators and workflow starts can change source state without
      // invalidating this console's cache; the fleet feed reports it, so the timer is the fallback.
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: CatalogSourceListPage | undefined } }) => {
        const page = query.state.data;
        if (!polling || page === undefined) return false;
        return page.sources.some((source) => source.state === 'loading')
          ? ACTIVE_SOURCE_POLL_MS
          : SETTLED_SOURCE_POLL_MS;
      },
    };
  });

  const sources = $derived(sourcesQuery.data?.sources ?? []);
  const nextOffset = $derived(sourcesQuery.data?.nextOffset);
  const canGoBack = $derived(offset > 0);
  const canGoForward = $derived(nextOffset !== undefined);
  const currentPage = $derived(Math.floor(offset / DYNAMIC_SOURCE_LIST_LIMIT) + 1);

  function previousPage(): void {
    offset = Math.max(0, offset - DYNAMIC_SOURCE_LIST_LIMIT);
  }

  function nextPage(): void {
    if (nextOffset === undefined) return;
    offset = nextOffset;
  }

  function isSelected(source: CatalogSourceListEntry): boolean {
    return selectedKey?.name === source.name && selectedKey.revision === source.revision;
  }
</script>

<section class="weft-source-list" aria-label="Registered source list">
  <SectionHeading
    level={3}
    title="Registered source list"
    description="Select a registered dynamic source revision, or use the manual lookup below."
  >
    {#snippet actions()}
      <div class="weft-source-list__pager" role="group" aria-label="Source list pagination">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          label="Previous"
          disabled={!canGoBack || sourcesQuery.isPending || sourcesQuery.isPlaceholderData}
          onclick={previousPage}
        />
        <span class="weft-source-list__page">Page {currentPage}</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          label="Next"
          disabled={!canGoForward || sourcesQuery.isPending || sourcesQuery.isPlaceholderData}
          onclick={nextPage}
        />
      </div>
    {/snippet}
  </SectionHeading>

  {#if !canRead}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={4}
      title={API_REFERENCE_COPY.notAvailable('The source list')}
      description={API_REFERENCE_COPY.requiresScope('system:read', 'list registered sources')}
    />
  {:else if sourcesQuery.isPending || sourcesQuery.isPlaceholderData}
    <div role="status" aria-busy="true" aria-label={API_REFERENCE_COPY.sources.loadingSources}>
      <Skeleton height="6rem" />
    </div>
  {:else if sourcesQuery.isError}
    <QueryFaultBanner error={sourcesQuery.error} onRetry={() => sourcesQuery.refetch()} />
  {:else if sources.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      title={offset === 0
        ? API_REFERENCE_COPY.sources.sourceListEmptyTitle
        : API_REFERENCE_COPY.sources.sourcePageEmptyTitle}
      description={offset === 0
        ? API_REFERENCE_COPY.sources.sourceListEmptyDescription
        : API_REFERENCE_COPY.sources.sourcePageEmptyDescription}
      headingLevel={4}
    >
      {#snippet action()}
        {#if offset > 0}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            label={API_REFERENCE_COPY.sources.previousPage}
            onclick={previousPage}
          />
        {/if}
      {/snippet}
      {#snippet icon()}
        <DatabaseZap aria-hidden="true" size={24} />
      {/snippet}
    </EmptyState>
  {:else}
    <Table caption="Registered dynamic workflow sources" scrollable class="weft-source-list__table">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Name</Table.HeaderCell>
          <Table.HeaderCell>Revision</Table.HeaderCell>
          <Table.HeaderCell>Kind</Table.HeaderCell>
          <Table.HeaderCell>State</Table.HeaderCell>
          <Table.HeaderCell>Select</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each sources as source (`${source.name}\u0000${source.revision}`)}
          <Table.Row>
            <Table.Cell as="th">
              <span class="weft-source-list__mono">{source.name}</span>
            </Table.Cell>
            <Table.Cell title={source.revision}>
              <span class="weft-source-list__revision">{JSON.stringify(source.revision)}</span>
            </Table.Cell>
            <Table.Cell><Badge variant="neutral" monospace>{source.kind}</Badge></Table.Cell>
            <Table.Cell><Badge variant="neutral">{source.state}</Badge></Table.Cell>
            <Table.Cell align="right">
              <Button
                type="button"
                size="sm"
                variant={isSelected(source) ? 'primary' : 'secondary'}
                label={isSelected(source) ? 'Selected' : 'Select'}
                onclick={() => onSelect(source)}
                title={`Select ${source.name} at revision ${JSON.stringify(source.revision)}`}
              />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
</section>

<style>
  .weft-source-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-source-list__page {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-source-list__pager {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .weft-source-list__mono,
  .weft-source-list__revision {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }

  .weft-source-list__revision {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
