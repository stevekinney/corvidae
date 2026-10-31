<script lang="ts">
  /**
   * Operations tab (plan §9.7 T7.4; design `Weft UI.dc.html` "System" §
   * OPERATION CATALOG). Searchable table sourced from the OpenAPI/OpenRPC
   * discovery documents + a `PermissionMatrix` scope/domain toggle — see
   * `scope-domain-matrix.ts`'s module doc for exactly what that matrix does
   * and doesn't claim (never per-operation required scope, which no
   * discovery document advertises).
   */
  import {
    Badge,
    EmptyState,
    PermissionMatrix,
    Segment,
    SegmentedControl,
    SearchField,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { Check, Minus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { API_REFERENCE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { fetchDiscoveryDocument } from './discovery-client.ts';
  import {
    buildOperationCatalog,
    filterOperationCatalog,
    type OpenApiDocumentLike,
    type OpenRpcDocumentLike,
  } from './operation-catalog.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import {
    domainColumnsFromTags,
    scopeDomainCellState,
    SCOPE_MATRIX_ROWS,
  } from './scope-domain-matrix.ts';

  const client = getClient();

  const openapiQuery = createQuery(() => ({
    queryKey: ['system', 'discovery', 'openapi'],
    queryFn: (): Promise<OpenApiDocumentLike> =>
      fetchDiscoveryDocument(client, 'openapi') as Promise<OpenApiDocumentLike>,
    retry: false,
  }));
  const openrpcQuery = createQuery(() => ({
    queryKey: ['system', 'discovery', 'openrpc'],
    queryFn: (): Promise<OpenRpcDocumentLike> =>
      fetchDiscoveryDocument(client, 'openrpc') as Promise<OpenRpcDocumentLike>,
    retry: false,
  }));

  let searchQuery = $state('');
  let view = $state<'table' | 'matrix'>('table');
</script>

<div class="weft-operations-tab">
  {#if openapiQuery.isPending || openrpcQuery.isPending}
    <div
      role="status"
      aria-busy="true"
      aria-label={API_REFERENCE_COPY.loading.operations}
      class="weft-operations-tab__loading"
    >
      <Skeleton height="2rem" width="300px" />
      <Skeleton height="12rem" />
    </div>
  {:else if openapiQuery.isError}
    <QueryFaultBanner error={openapiQuery.error} onRetry={() => openapiQuery.refetch()} />
  {:else if openrpcQuery.isError}
    <QueryFaultBanner error={openrpcQuery.error} onRetry={() => openrpcQuery.refetch()} />
  {:else}
    {@const catalog = buildOperationCatalog(openapiQuery.data, openrpcQuery.data)}
    <div class="weft-operations-tab__toolbar">
      <SearchField
        id="operation-search"
        class="weft-operations-tab__search"
        aria-label={API_REFERENCE_COPY.operations.searchLabel}
        placeholder={API_REFERENCE_COPY.operations.searchPlaceholder}
        bind:value={searchQuery}
        onClear={() => (searchQuery = '')}
      />
      <SegmentedControl
        id="operations-view"
        label="Catalog view"
        labelVisible={false}
        value={view}
        onValueChange={(next) => (view = next)}
      >
        <Segment value="table">Table</Segment>
        <Segment value="matrix">Scope matrix</Segment>
      </SegmentedControl>
    </div>

    {#if view === 'table'}
      {@const rows = filterOperationCatalog(catalog, searchQuery)}
      <p class="weft-operations-tab__scope-note">
        The discovery documents do not list the scope each operation needs yet. Your scopes shows
        what each granted scope unlocks.
      </p>
      {#if rows.length === 0}
        <EmptyState
          kind="filtered"
          headingLevel={2}
          title={API_REFERENCE_COPY.operations.noMatchTitle}
          description={API_REFERENCE_COPY.operations.noMatchDescription(searchQuery)}
          clearFiltersLabel={API_REFERENCE_COPY.operations.clearSearch}
          onClearFilters={() => (searchQuery = '')}
        />
      {:else}
        <Table caption="Operation catalog" scrollable>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Operation</Table.HeaderCell>
              <Table.HeaderCell>REST</Table.HeaderCell>
              <Table.HeaderCell>JSON-RPC</Table.HeaderCell>
              <Table.HeaderCell>MCP</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each rows as row (row.name)}
              <Table.Row>
                <Table.Cell as="th"><code>{row.name}</code></Table.Cell>
                <Table.Cell>
                  {#if row.restMethod && row.restPath}
                    <Badge variant="neutral">{row.restMethod}</Badge>
                    <code class="weft-operations-tab__path">{row.restPath}</code>
                  {:else}
                    —
                  {/if}
                </Table.Cell>
                <Table.Cell>
                  {#if row.jsonRpc}<Check aria-hidden="true" size={14} />{:else}<Minus
                      aria-hidden="true"
                      size={14}
                    />{/if}
                </Table.Cell>
                <Table.Cell>
                  {#if row.mcp}<Check aria-hidden="true" size={14} />{:else}<Minus
                      aria-hidden="true"
                      size={14}
                    />{/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
      {/if}
    {:else}
      {@const columns = domainColumnsFromTags(catalog.flatMap((row) => row.tags))}
      <p class="weft-operations-tab__matrix-note">
        Domain affinity derived from scope and tag naming — NOT per-operation required scope
        (discovery documents don't advertise that yet). "Same domain" means the scope's vocabulary
        covers this area of the API, not that any specific operation requires it.
      </p>
      <PermissionMatrix
        label="Scope domain matrix"
        rows={SCOPE_MATRIX_ROWS}
        {columns}
        getCellState={scopeDomainCellState}
        stateLabels={{ granted: 'Same domain', 'not-applicable': '—' }}
      />
    {/if}
  {/if}
</div>

<style>
  .weft-operations-tab {
    min-width: 0;
    max-width: 1080px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .weft-operations-tab__loading {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* A path has no space to break at, so it may break anywhere instead of widening the table. */
  .weft-operations-tab__path {
    overflow-wrap: anywhere;
  }

  .weft-operations-tab__toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .weft-operations-tab__toolbar :global(.weft-operations-tab__search) {
    flex: 1;
    max-width: 300px;
  }

  .weft-operations-tab__scope-note {
    margin: 0;
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-disabled);
  }

  .weft-operations-tab__matrix-note {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
    max-width: 640px;
  }
</style>
