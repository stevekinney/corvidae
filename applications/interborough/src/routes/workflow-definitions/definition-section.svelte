<script lang="ts">
  /**
   * What the engine says a workflow type is: its description, the schemas of its input and output,
   * the signals it accepts, its updates and queries, and the revision a new run would use. The
   * signals are passed in, because an agent-authored workflow accepts the signals its steps wait
   * for, and a code-defined one the signals its contract names.
   */
  import { CodeBlock } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import type { DefinitionDetail } from '../../lib/workflow-catalog.ts';

  interface Props {
    definition: DefinitionDetail;
    signals: readonly string[];
  }

  let { definition, signals }: Props = $props();

  const copy = WORKFLOW_COPY.definition;

  /** A schema the contract declares, as text to read, or `undefined` when it declares none. */
  function schemaText(key: 'inputSchema' | 'outputSchema'): string | undefined {
    const schema = definition.contract?.[key];
    return schema === undefined || schema === null ? undefined : JSON.stringify(schema, null, 2);
  }

  const inputSchema = $derived(schemaText('inputSchema'));
  const outputSchema = $derived(schemaText('outputSchema'));
</script>

{#snippet names(label: string, entries: readonly string[], testId?: string)}
  <dt>{label}</dt>
  <dd data-testid={testId}>{entries.length === 0 ? copy.none : entries.join(', ')}</dd>
{/snippet}

{#snippet schema(label: string, text: string | undefined)}
  <h3 class="weft-workflow-definition__subheading">{label}</h3>
  {#if text === undefined}
    <p class="weft-workflow-definition__none">{copy.noSchema}</p>
  {:else}
    <CodeBlock code={text} language="json" highlight={false} />
  {/if}
{/snippet}

<section class="weft-workflow-definition" data-testid="workflow-definition">
  <h2 class="weft-workflow-section__heading">{copy.heading}</h2>
  <p class="weft-workflow-definition__description">
    {definition.description ?? copy.noDescription}
  </p>
  <dl class="weft-workflow-facts">
    <dt>{copy.revision}</dt>
    <dd><code>{definition.revision ?? copy.noRevision}</code></dd>
    {@render names(copy.signals, signals, 'workflow-accepted-signals')}
    {@render names(copy.updates, definition.updates ?? [])}
    {@render names(copy.queries, definition.queries ?? [])}
  </dl>
  {@render schema(copy.inputSchema, inputSchema)}
  {@render schema(copy.outputSchema, outputSchema)}
</section>

<style>
  .weft-workflow-definition {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-workflow-definition__description {
    margin: 0;
  }

  .weft-workflow-definition__subheading {
    margin: 8px 0 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-workflow-definition__none {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
