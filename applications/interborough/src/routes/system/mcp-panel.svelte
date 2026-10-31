<script lang="ts">
  /**
   * Discovery → MCP sub-view (plan §9.7 T7.3; design `Weft UI.dc.html`
   * "System" § DISCOVERY, MCP session protocol card). Renders
   * `/.well-known/mcp.json`, the static session-protocol sequence diagram,
   * and the interactive "Test MCP session" panel — including the honest
   * `publicOrigin`/`trustedHosts` 503 case (plan: "note ... 503 behavior with
   * an actionable message").
   *
   * The test-session `CodeBlock` uses `highlight={false}` — see
   * `metrics-tab.svelte`'s module doc for why `language="text"` alone still
   * triggers Shiki's "language not in bundle" warning.
   */
  import {
    Button,
    Card,
    CodeBlock,
    DescriptionList,
    EmptyState,
    Skeleton,
  } from '@lostgradient/cinder';
  import { Plug } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { API_REFERENCE_COPY } from '../../app/copy.ts';
  import { codeHighlighter } from '../../lib/code-highlighter.ts';
  import { getClient } from '../../lib/client.ts';
  import { DiscoveryFetchError, fetchDiscoveryDocument } from './discovery-client.ts';
  import McpSessionDiagram from './mcp-session-diagram.svelte';
  import { testMcpSession, type McpTestSessionResult } from './mcp-test-session.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';

  const client = getClient();

  interface McpDiscoveryDocumentLike {
    readonly protocol?: string;
    readonly protocolVersion?: string;
    readonly serverInfo?: { readonly name?: string; readonly version?: string };
    readonly transports?: {
      readonly streamableHttp?: { readonly url?: string };
      readonly stdio?: { readonly command?: string };
    };
  }

  const mcpQuery = createQuery(() => ({
    queryKey: ['system', 'discovery', 'mcp'],
    queryFn: (): Promise<McpDiscoveryDocumentLike> =>
      fetchDiscoveryDocument(client, 'mcp') as Promise<McpDiscoveryDocumentLike>,
    // See `metrics-tab.svelte`'s `retry: false` for why: `DiscoveryFetchError`
    // is a definitive result (often the documented 503), not transient.
    retry: false,
  }));

  let testResult = $state<McpTestSessionResult | null>(null);
  let testError = $state<unknown>(null);
  let testing = $state(false);

  async function runTest(): Promise<void> {
    testing = true;
    testError = null;
    try {
      testResult = await testMcpSession(client);
    } catch (error) {
      testError = error;
    } finally {
      testing = false;
    }
  }

  function isPublicOriginNotConfigured(error: unknown): boolean {
    return error instanceof DiscoveryFetchError && error.status === 503;
  }
</script>

<div class="weft-mcp-panel">
  {#if mcpQuery.isPending}
    <div role="status" aria-busy="true" aria-label={API_REFERENCE_COPY.loading.mcp}>
      <Skeleton height="8rem" />
    </div>
  {:else if mcpQuery.isError && isPublicOriginNotConfigured(mcpQuery.error)}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={API_REFERENCE_COPY.mcp.unavailableTitle}
      description={API_REFERENCE_COPY.mcp.unavailableDescription}
    />
  {:else if mcpQuery.isError}
    <QueryFaultBanner error={mcpQuery.error} onRetry={() => mcpQuery.refetch()} />
  {:else}
    <DescriptionList
      items={[
        { term: 'Protocol', definition: mcpQuery.data.protocol ?? '—' },
        { term: 'Protocol version', definition: mcpQuery.data.protocolVersion ?? '—' },
        {
          term: 'Server',
          definition: `${mcpQuery.data.serverInfo?.name ?? '—'} · ${mcpQuery.data.serverInfo?.version ?? '—'}`,
        },
        {
          term: 'Streamable HTTP',
          definition: mcpQuery.data.transports?.streamableHttp?.url ?? '—',
        },
        { term: 'stdio command', definition: mcpQuery.data.transports?.stdio?.command ?? '—' },
      ]}
    />
    <CodeBlock
      code={JSON.stringify(mcpQuery.data, null, 2)}
      language="json"
      highlighter={codeHighlighter}
      copyable
    />
  {/if}

  <Card title="MCP session protocol" headingLevel={2}>
    <McpSessionDiagram />
  </Card>

  <Card>
    {#snippet header()}
      <div class="weft-mcp-panel__test-title">
        <h2 class="weft-mcp-panel__test-heading">Test MCP session</h2>
        <Button
          data-changes
          variant="secondary"
          size="sm"
          label={testing ? 'Testing…' : 'Test'}
          onclick={runTest}
          disabled={testing}
        >
          {#snippet leadingIcon()}<Plug aria-hidden="true" size={13} />{/snippet}
        </Button>
      </div>
    {/snippet}

    {#if testError}
      <QueryFaultBanner error={testError} onRetry={runTest} />
    {:else if testResult}
      <CodeBlock
        language="text"
        highlight={false}
        copyable
        code={[
          `POST ${testResult.request.url}`,
          ...Object.entries(testResult.request.headers).map(([key, value]) => `${key}: ${value}`),
          '',
          JSON.stringify(testResult.request.body, null, 2),
          '',
          `HTTP/1.1 ${testResult.response.status} ${testResult.response.statusText}`,
          ...Object.entries(testResult.response.headers).map(([key, value]) => `${key}: ${value}`),
          '',
          typeof testResult.response.body === 'string'
            ? testResult.response.body
            : JSON.stringify(testResult.response.body, null, 2),
        ].join('\n')}
      />
    {:else}
      <p class="weft-mcp-panel__test-hint">
        Sends a real <code>initialize</code> request and shows the full request/response headers and body.
      </p>
    {/if}
  </Card>
</div>

<style>
  .weft-mcp-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    max-width: 720px;
  }

  .weft-mcp-panel__test-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .weft-mcp-panel__test-heading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-mcp-panel__test-hint {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-mcp-panel__test-hint code {
    font-family: var(--cinder-font-mono);
  }
</style>
