<script lang="ts">
  /**
   * The Operations tab (board PageSettingsSections, "API reference · Operations"): a group select
   * that reads "All groups", the count of operations shown, and a table of method, path, what the
   * operation does and the scope it needs. A row opens to show an example request body and the
   * response, in code blocks. The operations are the server's own OpenAPI description
   * (`api-operations.ts`).
   */
  import { Badge, Button, CodeBlock, Select, Table, VisuallyHidden } from '@lostgradient/cinder';
  import { ChevronDown, ChevronRight } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { SvelteSet } from 'svelte/reactivity';

  import { API_REFERENCE_COPY } from '../../../app/copy.ts';
  import { codeHighlighter } from '../../../lib/code-highlighter.ts';
  import { getClient } from '../../../lib/client.ts';
  import { fetchDiscoveryDocument } from '../../system/discovery-client.ts';
  import {
    buildApiOperations,
    operationGroups,
    type ApiOperation,
    type OpenApiDocumentLike,
  } from './api-operations.ts';
  import { failureStatusOf } from './failure-status.ts';
  import LoadState from './load-state.svelte';

  const client = getClient();
  const queryClient = useQueryClient();
  const copy = API_REFERENCE_COPY.operations;
  const ALL = '';
  const QUERY_KEY = ['api-reference', 'openapi'] as const;

  const document = createQuery(
    () => ({
      queryKey: QUERY_KEY,
      queryFn: async (): Promise<OpenApiDocumentLike> =>
        (await fetchDiscoveryDocument(client, 'openapi')) as OpenApiDocumentLike,
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );

  let canceled = $state(false);
  let group = $state(ALL);
  const open = new SvelteSet<string>();

  const operations = $derived(document.data === undefined ? [] : buildApiOperations(document.data));
  const groups = $derived(operationGroups(operations));
  const shown = $derived(
    group === ALL ? operations : operations.filter((row) => row.group === group),
  );

  const failureStatus = $derived(failureStatusOf(document.error));

  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: QUERY_KEY });
  }

  function tryAgain(): void {
    canceled = false;
    void document.refetch();
  }

  function toggle(id: string): void {
    if (open.has(id)) open.delete(id);
    else open.add(id);
  }

  const detailId = (operation: ApiOperation): string => `ib-api-operation-${operation.id}`;
</script>

{#if document.data !== undefined}
  <div class="ib-api-operations" data-testid="api-operations">
    <div class="ib-api-operations__toolbar">
      <div class="ib-api-operations__group">
        <Select
          id="ib-api-operations-group"
          label={copy.groupLabel}
          labelVisible={false}
          value={group}
          options={[
            { value: ALL, label: copy.allGroups },
            ...groups.map((name) => ({ value: name, label: name })),
          ]}
          onchange={(event) => (group = event.currentTarget.value)}
        />
      </div>
      <span class="ib-api-operations__count" data-testid="api-operations-count"
        >{copy.count(shown.length)}</span
      >
    </div>

    {#if shown.length === 0}
      <p class="ib-api-operations__empty">{copy.empty}</p>
    {:else}
      <Table caption={copy.caption} scrollable>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{copy.columns.method}</Table.HeaderCell>
            <Table.HeaderCell>{copy.columns.path}</Table.HeaderCell>
            <Table.HeaderCell>{copy.columns.summary}</Table.HeaderCell>
            <Table.HeaderCell>{copy.columns.scope}</Table.HeaderCell>
            <Table.HeaderCell
              ><VisuallyHidden>{copy.columns.details}</VisuallyHidden></Table.HeaderCell
            >
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each shown as operation (operation.id)}
            <Table.Row data-operation={operation.id}>
              <Table.Cell><Badge variant="neutral" monospace>{operation.method}</Badge></Table.Cell>
              <Table.Cell><code class="ib-api-operations__path">{operation.path}</code></Table.Cell>
              <Table.Cell>{operation.summary}</Table.Cell>
              <Table.Cell>
                {#if operation.scope === undefined}
                  <span class="ib-api-operations__muted">{copy.noScope}</span>
                {:else}
                  <code class="ib-api-operations__scope">{operation.scope}</code>
                {/if}
              </Table.Cell>
              <Table.Cell align="right">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  label={copy.toggleLabel(operation.method, operation.path)}
                  aria-expanded={open.has(operation.id)}
                  aria-controls={detailId(operation)}
                  onclick={() => toggle(operation.id)}
                >
                  {#if open.has(operation.id)}
                    <ChevronDown size={16} aria-hidden="true" />
                  {:else}
                    <ChevronRight size={16} aria-hidden="true" />
                  {/if}
                </Button>
              </Table.Cell>
            </Table.Row>
            {#if open.has(operation.id)}
              <Table.Row>
                <Table.Cell colspan={5}>
                  <div class="ib-api-operations__detail" id={detailId(operation)}>
                    <section aria-label={copy.requestBody}>
                      <h3 class="ib-api-operations__heading">{copy.requestBody}</h3>
                      {#if operation.request === undefined}
                        <p class="ib-api-operations__muted">{copy.noRequestBody}</p>
                      {:else}
                        <CodeBlock
                          code={operation.request}
                          language="json"
                          highlighter={codeHighlighter}
                        />
                      {/if}
                    </section>
                    <section aria-label={copy.response(operation.responseStatus ?? '')}>
                      <h3 class="ib-api-operations__heading">
                        {copy.response(operation.responseStatus ?? '')}
                      </h3>
                      {#if operation.response === undefined}
                        <p class="ib-api-operations__muted">{copy.noResponseBody}</p>
                      {:else}
                        <CodeBlock
                          code={operation.response}
                          language="json"
                          highlighter={codeHighlighter}
                        />
                      {/if}
                    </section>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        </Table.Body>
      </Table>
    {/if}
  </div>
{:else}
  <LoadState
    kind={document.isError ? 'error' : canceled ? 'canceled' : 'loading'}
    status={failureStatus}
    onCancel={cancelLoading}
    onRetry={tryAgain}
  />
{/if}

<style>
  .ib-api-operations {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-api-operations__toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
  }

  .ib-api-operations__group {
    inline-size: 12rem;
  }

  .ib-api-operations__count,
  .ib-api-operations__muted,
  .ib-api-operations__empty {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-api-operations__path,
  .ib-api-operations__scope {
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .ib-api-operations__detail {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--cinder-space-4);
    min-inline-size: 0;
  }

  .ib-api-operations__heading {
    margin: 0 0 var(--cinder-space-2);
    font-size: var(--cinder-text-sm);
    font-weight: 500;
    color: var(--cinder-text-muted);
  }
</style>
