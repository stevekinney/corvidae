<script lang="ts">
  /**
   * Discovery tab (plan §9.7 T7.3; design `Weft UI.dc.html` "System" §
   * DISCOVERY). Rendered OpenAPI / OpenRPC / AsyncAPI viewers (method/path,
   * summary, tags — see `operation-catalog.ts`'s module doc for why
   * "required scope" is honestly absent) + raw-JSON toggle, plus the MCP
   * sub-view (`mcp-panel.svelte`).
   */
  import {
    Badge,
    CodeBlock,
    EmptyState,
    Segment,
    SegmentedControl,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { API_REFERENCE_COPY } from '../../app/copy.ts';
  import { codeHighlighter } from '../../lib/code-highlighter.ts';
  import { getClient } from '../../lib/client.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { groupPath } from '../settings/api-reference-groups.ts';
  import { extractAsyncApiChannels, type AsyncApiDocumentLike } from './asyncapi-channels.ts';
  import { fetchDiscoveryDocument } from './discovery-client.ts';
  import McpPanel from './mcp-panel.svelte';
  import {
    buildOperationCatalog,
    filterOperationCatalog,
    type OpenApiDocumentLike,
    type OpenRpcDocumentLike,
  } from './operation-catalog.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';

  const client = getClient();

  const VIEWS = ['openapi', 'openrpc', 'asyncapi', 'mcp'] as const;
  type DiscoveryView = (typeof VIEWS)[number];

  // The open document is the `document` search parameter, so a document is linked to and survives
  // a reload, and the responsive specification can open each one.
  const view = $derived<DiscoveryView>(
    VIEWS.find((candidate) => candidate === router.search.get('document')) ?? 'openapi',
  );
  let showRaw = $state(false);

  function openDocument(next: string): void {
    router.navigate(`${groupPath('discovery')}&document=${next}`);
  }

  // `retry: false` on every query below — see `metrics-tab.svelte`'s
  // `rawQuery` for why `DiscoveryFetchError` shouldn't get the QueryClient's
  // generic "retry non-Weft-fault errors" default.
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
  const asyncapiQuery = createQuery(() => ({
    queryKey: ['system', 'discovery', 'asyncapi'],
    queryFn: (): Promise<AsyncApiDocumentLike> =>
      fetchDiscoveryDocument(client, 'asyncapi') as Promise<AsyncApiDocumentLike>,
    retry: false,
  }));
</script>

{#snippet loading()}
  <div
    role="status"
    aria-busy="true"
    aria-label={API_REFERENCE_COPY.loading.discovery}
    class="weft-discovery-tab__loading"
  >
    <Skeleton height="12rem" />
  </div>
{/snippet}

{#snippet nothingListed()}
  <EmptyState
    kind="first-use"
    headingLevel={2}
    title={API_REFERENCE_COPY.discovery.emptyTitle}
    description={API_REFERENCE_COPY.discovery.emptyDescription}
  />
{/snippet}

<div class="weft-discovery-tab">
  <div class="weft-discovery-tab__toolbar">
    <SegmentedControl
      id="discovery-view"
      label={API_REFERENCE_COPY.discovery.documentLabel}
      labelVisible={false}
      value={view}
      onValueChange={openDocument}
    >
      <Segment value="openapi">OpenAPI</Segment>
      <Segment value="openrpc">OpenRPC</Segment>
      <Segment value="asyncapi">AsyncAPI</Segment>
      <Segment value="mcp">MCP</Segment>
    </SegmentedControl>

    {#if view !== 'mcp'}
      <label class="weft-discovery-tab__raw-toggle">
        <input type="checkbox" bind:checked={showRaw} />
        {API_REFERENCE_COPY.discovery.rawJson}
      </label>
    {/if}
  </div>

  {#if view === 'openapi'}
    {#if openapiQuery.isPending}
      {@render loading()}
    {:else if openapiQuery.isError}
      <QueryFaultBanner error={openapiQuery.error} onRetry={() => openapiQuery.refetch()} />
    {:else if showRaw}
      <CodeBlock
        code={JSON.stringify(openapiQuery.data, null, 2)}
        language="json"
        highlighter={codeHighlighter}
        copyable
      />
    {:else}
      {@const rows = filterOperationCatalog(buildOperationCatalog(openapiQuery.data, null), '')}
      {#if rows.length === 0}
        {@render nothingListed()}
      {:else}
        <Table caption="OpenAPI operations" scrollable>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Method</Table.HeaderCell>
              <Table.HeaderCell>Path</Table.HeaderCell>
              <Table.HeaderCell>Summary</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each rows as row (row.name)}
              <Table.Row>
                <Table.Cell as="th">
                  <Badge variant="neutral">{row.restMethod}</Badge>
                </Table.Cell>
                <Table.Cell><code class="weft-discovery-tab__path">{row.restPath}</code></Table.Cell
                >
                <Table.Cell>{row.summary ?? '—'}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
      {/if}
    {/if}
  {:else if view === 'openrpc'}
    {#if openrpcQuery.isPending}
      {@render loading()}
    {:else if openrpcQuery.isError}
      <QueryFaultBanner error={openrpcQuery.error} onRetry={() => openrpcQuery.refetch()} />
    {:else if showRaw}
      <CodeBlock
        code={JSON.stringify(openrpcQuery.data, null, 2)}
        language="json"
        highlighter={codeHighlighter}
        copyable
      />
    {:else}
      {@const rows = filterOperationCatalog(buildOperationCatalog(null, openrpcQuery.data), '')}
      {#if rows.length === 0}
        {@render nothingListed()}
      {:else}
        <Table caption="OpenRPC methods" scrollable>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Method</Table.HeaderCell>
              <Table.HeaderCell>Summary</Table.HeaderCell>
              <Table.HeaderCell>MCP</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each rows as row (row.name)}
              <Table.Row>
                <Table.Cell as="th"><code>{row.name}</code></Table.Cell>
                <Table.Cell>{row.summary ?? '—'}</Table.Cell>
                <Table.Cell>{row.mcp ? row.mcpToolName : '—'}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
      {/if}
    {/if}
  {:else if view === 'asyncapi'}
    {#if asyncapiQuery.isPending}
      {@render loading()}
    {:else if asyncapiQuery.isError}
      <QueryFaultBanner error={asyncapiQuery.error} onRetry={() => asyncapiQuery.refetch()} />
    {:else if showRaw}
      <CodeBlock
        code={JSON.stringify(asyncapiQuery.data, null, 2)}
        language="json"
        highlighter={codeHighlighter}
        copyable
      />
    {:else}
      {@const rows = extractAsyncApiChannels(asyncapiQuery.data)}
      {#if rows.length === 0}
        {@render nothingListed()}
      {:else}
        <Table caption="AsyncAPI channels" scrollable>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Channel</Table.HeaderCell>
              <Table.HeaderCell>Address</Table.HeaderCell>
              <Table.HeaderCell>Title</Table.HeaderCell>
              <Table.HeaderCell align="right">Messages</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each rows as row (row.channel)}
              <Table.Row>
                <Table.Cell as="th"><code>{row.channel}</code></Table.Cell>
                <Table.Cell><code>{row.address ?? '—'}</code></Table.Cell>
                <Table.Cell>{row.title ?? '—'}</Table.Cell>
                <Table.Cell align="right">{row.messageCount}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table>
      {/if}
    {/if}
  {:else}
    <McpPanel />
  {/if}

  <p class="weft-discovery-tab__scope-note">
    {API_REFERENCE_COPY.discovery.scopeNote}
  </p>
</div>

<style>
  .weft-discovery-tab {
    min-width: 0;
    max-width: 1000px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .weft-discovery-tab__toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
  }

  .weft-discovery-tab__raw-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
  }

  .weft-discovery-tab__loading {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* A path has no space to break at, so it may break anywhere instead of widening the table. */
  .weft-discovery-tab__path {
    overflow-wrap: anywhere;
  }

  .weft-discovery-tab__scope-note {
    margin: 0;
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-disabled);
  }
</style>
