<script lang="ts">
  /**
   * The Operations tab (board PageSettingsSections, "API reference, Operations"): a group select
   * that reads "All groups", the count of operations shown, and a table of method, path, what the
   * operation does and the scope it needs, with the chevron that opens a row at the row's right.
   * The method is monospaced text in its method's colour, as the board draws it. A row opens to
   * show an example request body and the response, in code blocks. The path and the summary are
   * held to a width and wrap inside it, so no column asks for more than the table has, at 375px
   * as at 1280. The operations are Interborough's own OpenAPI description (`/api/openapi.json`,
   * `api-operations.ts`), in the order it lists them.
   */
  import { Button, CodeBlock, Select, Table, VisuallyHidden } from '@lostgradient/cinder';
  import { ChevronDown, ChevronRight } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { SvelteSet } from 'svelte/reactivity';

  import { API_REFERENCE_COPY } from '../../../app/copy/api-reference.ts';
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
  const QUERY_KEY = ['api-reference', 'api'] as const;

  const document = createQuery(
    () => ({
      queryKey: QUERY_KEY,
      queryFn: async (): Promise<OpenApiDocumentLike> =>
        (await fetchDiscoveryDocument(client, 'api')) as OpenApiDocumentLike,
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
      <Table caption={copy.caption} scrollable={false}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{copy.columns.method}</Table.HeaderCell>
            <Table.HeaderCell>{copy.columns.path}</Table.HeaderCell>
            <Table.HeaderCell class="ib-api-operations__wide"
              >{copy.columns.summary}</Table.HeaderCell
            >
            <Table.HeaderCell class="ib-api-operations__wide">{copy.columns.scope}</Table.HeaderCell
            >
            <Table.HeaderCell
              ><VisuallyHidden>{copy.columns.details}</VisuallyHidden></Table.HeaderCell
            >
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each shown as operation (operation.id)}
            <Table.Row data-operation={operation.id}>
              <Table.Cell>
                <code class="ib-api-operations__method" data-method={operation.method}
                  >{operation.method}</code
                >
              </Table.Cell>
              <Table.Cell
                ><code class="ib-api-operations__path"
                  >{#each operation.path.split('/') as segment, index (index)}{#if index > 0}/<wbr
                      />{/if}{segment}{/each}</code
                >
                <!-- On a narrow page what it does and its scope sit under the path, and their own
                     columns leave: four columns of wrapped words do not fit at 375px. -->
                <span class="ib-api-operations__narrow">
                  <span class="ib-api-operations__summary">{operation.summary}</span>
                  {#if operation.scope === undefined}
                    <span class="ib-api-operations__muted">{copy.noScope}</span>
                  {:else}
                    <code class="ib-api-operations__scope">{operation.scope}</code>
                  {/if}
                </span></Table.Cell
              >
              <Table.Cell class="ib-api-operations__wide"
                ><span class="ib-api-operations__summary">{operation.summary}</span></Table.Cell
              >
              <Table.Cell class="ib-api-operations__wide">
                {#if operation.scope === undefined}
                  <span class="ib-api-operations__muted">{copy.noScope}</span>
                {:else}
                  <code class="ib-api-operations__scope">{operation.scope}</code>
                {/if}
              </Table.Cell>
              <Table.Cell>
                <span class="ib-api-operations__toggle">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    quiet
                    label={copy.toggleLabel(operation.method, operation.path)}
                    aria-expanded={open.has(operation.id)}
                    aria-controls={detailId(operation)}
                    onclick={() => toggle(operation.id)}
                  >
                    {#if open.has(operation.id)}
                      <ChevronDown size={14} aria-hidden="true" />
                    {:else}
                      <ChevronRight size={14} aria-hidden="true" />
                    {/if}
                  </Button>
                </span>
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
                          languageLabelVisible={false}
                          wrap
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
                          languageLabelVisible={false}
                          wrap
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
    container-type: inline-size;
  }

  .ib-api-operations__narrow {
    display: none;
  }

  /* Narrower than four columns of words can share, what an operation does and its scope move
   * under its path, so the method, the path and the chevron keep their room. */
  @container (inline-size < 36rem) {
    .ib-api-operations :global(.ib-api-operations__wide) {
      display: none;
    }

    .ib-api-operations__narrow {
      display: flex;
      flex-direction: column;
      gap: var(--cinder-space-0-5);
      margin-block-start: var(--cinder-space-1);
    }
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

  /* A path breaks at its slashes, and a scope is one word: neither is cut inside a segment. */
  .ib-api-operations__path,
  .ib-api-operations__scope {
    font-size: var(--cinder-text-xs);
  }

  /* The table never scrolls sideways: it is as wide as its column and its cells wrap, the path at
   * each slash and the scope anywhere, so the whole row, chevron included, fits at 375px. The two
   * long columns are held to a width, so on a wide page neither takes the room of the others. */
  .ib-api-operations__path {
    display: block;
    max-inline-size: 13rem;
  }

  .ib-api-operations__summary {
    display: block;
    max-inline-size: 14rem;
  }

  .ib-api-operations__method {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    font-weight: var(--cinder-font-bold);
    color: var(--cinder-text-muted);
  }

  /* The board's method colours: a read in the info hue, a write in the success hue. */
  .ib-api-operations__method[data-method='GET'] {
    color: var(--cinder-status-info-text);
  }

  .ib-api-operations__method[data-method='POST'],
  .ib-api-operations__method[data-method='PUT'],
  .ib-api-operations__method[data-method='PATCH'] {
    color: var(--cinder-status-success-text);
  }

  .ib-api-operations__method[data-method='DELETE'] {
    color: var(--cinder-status-danger-text);
  }

  .ib-api-operations__scope {
    color: var(--cinder-text-muted);
  }

  .ib-api-operations__toggle {
    display: flex;
    justify-content: flex-end;
    color: var(--cinder-text-muted);
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
