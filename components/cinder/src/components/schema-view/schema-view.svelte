<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Read-only view of a JSON Schema: one line per field with a label, a red dot when required, a monospace type and a description, nested objects indented, and a disclosure for the raw document.
   * @tag schema
   * @tag json-schema
   * @tag read-only
   * @tag data-display
   * @useWhen Showing the shape of a workflow input or output, a tool input, or a signal or update payload without a raw JSON dump.
   * @useWhen Telling the reader which fields are required and what type each one takes.
   * @avoidWhen The schema must be edited. | json-schema-editor
   * @avoidWhen You are showing a value rather than the shape it must have. | payload-inspector
   * @related json-schema-editor, payload-inspector, json-viewer, description-list
   */
  export type { SchemaViewProps } from './schema-view.types.ts';
</script>

<script lang="ts">
  import type { SchemaViewField } from './schema-view-fields.ts';
  import type { SchemaViewProps } from './schema-view.types.ts';

  import Collapsible from '../collapsible/collapsible.svelte';
  import JsonViewer from '../json-viewer/json-viewer.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import { readSchemaFields } from './schema-view-fields.ts';

  let {
    schema,
    label = 'Schema',
    maxDepth = 8,
    rawLabel = 'View JSON Schema',
    emptyLabel = 'This schema declares no fields.',
    class: className,
    ...rest
  }: SchemaViewProps = $props();

  const fields = $derived(readSchemaFields(schema, maxDepth));
</script>

{#snippet fieldList(entries: SchemaViewField[])}
  <ul class="cinder-schema-view__fields">
    {#each entries as field (field.key)}
      <li class="cinder-schema-view__field" data-cinder-required={field.required || undefined}>
        <div class="cinder-schema-view__line">
          <span class="cinder-schema-view__label">{field.label}</span>
          {#if field.required}
            <span class="cinder-schema-view__required" role="img" aria-label="Required"></span>
          {/if}
          <code class="cinder-schema-view__type">{field.type}</code>
          {#if field.description}
            <span class="cinder-schema-view__description">{field.description}</span>
          {/if}
        </div>
        {#if field.fields.length > 0}
          {@render fieldList(field.fields)}
        {:else if field.truncated}
          <p class="cinder-schema-view__truncated">
            Nested fields are not shown here. They are in the raw schema.
          </p>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<section {...rest} class={classNames('cinder-schema-view', className)} aria-label={label}>
  {#if fields.length > 0}
    {@render fieldList(fields)}
  {:else}
    <p class="cinder-schema-view__empty">{emptyLabel}</p>
  {/if}
  <Collapsible variant="flat" animated={false} trigger={rawLabel} class="cinder-schema-view__raw">
    <div class="cinder-schema-view__document">
      <JsonViewer value={schema} initialDepth={2} />
    </div>
  </Collapsible>
</section>
