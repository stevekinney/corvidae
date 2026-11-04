<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Read-only view of a JSON Schema as one aligned grid of Field, Type and Description: required fields first with a red dot, nested fields indented, plain-word types, a raw-document disclosure.
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
  import { SvelteSet } from 'svelte/reactivity';

  import type { SchemaViewField } from './schema-view-fields.ts';
  import type { SchemaViewProps } from './schema-view.types.ts';

  import Collapsible from '../collapsible/collapsible.svelte';
  import JsonViewer from '../json-viewer/json-viewer.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import { partitionRequiredFields, readSchemaFields } from './schema-view-fields.ts';

  let {
    schema,
    label = 'Schema',
    maxDepth = 8,
    rawLabel = 'JSON schema',
    emptyLabel = 'This schema takes no fields, so there is nothing to fill in.',
    caption,
    class: className,
    ...rest
  }: SchemaViewProps = $props();

  /** One row of the grid: a field, how deep it sits, and the labels of the fields above it. */
  type Row = {
    field: SchemaViewField;
    depth: number;
    ancestors: string[];
    /** True for the first optional row after the required rows: the hairline sits above it. */
    startsOptional: boolean;
  };

  const baseId = $props.id();
  const expanded = new SvelteSet<string>();

  function flatten(
    entries: readonly SchemaViewField[],
    depth: number,
    ancestors: string[],
    into: Row[],
  ): void {
    for (const field of entries) {
      into.push({ field, depth, ancestors, startsOptional: false });
      flatten(field.fields, depth + 1, [...ancestors, field.label], into);
    }
  }

  // Required fields read first, then a single hairline, then the rest. Only the top level is
  // reordered; a nested object keeps the order the schema declares.
  const rows = $derived.by((): Row[] => {
    const { required, optional } = partitionRequiredFields(readSchemaFields(schema, maxDepth));
    const result: Row[] = [];
    flatten(required, 0, [], result);
    const firstOptional = result.length;
    flatten(optional, 0, [], result);
    const first = result[firstOptional];
    if (first && firstOptional > 0) first.startsOptional = true;
    return result;
  });

  function toggle(path: string): void {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
  }
</script>

<section {...rest} class={classNames('cinder-schema-view', className)} aria-label={label}>
  {#if rows.length > 0}
    <div class="cinder-schema-view__frame">
      <div class="cinder-schema-view__grid" role="table" aria-label={label}>
        <div class="cinder-schema-view__group" role="rowgroup">
          <div class="cinder-schema-view__row cinder-schema-view__row--header" role="row">
            <div class="cinder-schema-view__cell" role="columnheader">Field</div>
            <div class="cinder-schema-view__cell" role="columnheader">Type</div>
            <div class="cinder-schema-view__cell" role="columnheader">Description</div>
          </div>
        </div>
        <div class="cinder-schema-view__group" role="rowgroup">
          {#each rows as row, index (row.field.path)}
            {@const field = row.field}
            {@const open = expanded.has(field.path)}
            {@const textId = `${baseId}-${index}`}
            <div
              class="cinder-schema-view__row"
              role="row"
              data-cinder-depth={row.depth}
              data-cinder-required={field.required || undefined}
              data-cinder-group-start={row.startsOptional || undefined}
              style:--_cinder-schema-view-depth={row.depth}
            >
              <div class="cinder-schema-view__cell cinder-schema-view__field" role="rowheader">
                {#if row.ancestors.length > 0}
                  <span class="cinder-sr-only">{`${row.ancestors.join(' › ')} › `}</span>
                {/if}
                <span class="cinder-schema-view__label" title={field.label}>{field.label}</span>
                {#if field.required}
                  <span class="cinder-schema-view__required" role="img" aria-label="Required"
                  ></span>
                {/if}
              </div>
              <div class="cinder-schema-view__cell cinder-schema-view__kind" role="cell">
                <span class="cinder-schema-view__type">{field.type}</span>
              </div>
              <div class="cinder-schema-view__cell cinder-schema-view__about" role="cell">
                {#if field.summary}
                  <span id={textId} class="cinder-schema-view__description"
                    >{open && field.detail
                      ? `${field.summary} ${field.detail}`
                      : field.summary}</span
                  >
                  {#if field.detail}
                    {' '}<button
                      type="button"
                      class="cinder-schema-view__toggle"
                      aria-expanded={open}
                      aria-controls={textId}
                      aria-label={`${open ? 'Less' : 'More'} about ${field.label}`}
                      onclick={() => toggle(field.path)}>{open ? 'Less' : 'More'}</button
                    >
                  {/if}
                {/if}
                {#if field.truncated}
                  <p class="cinder-schema-view__truncated">
                    Nested fields are not shown here. They are in the raw schema.
                  </p>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
      {#if caption}
        <p class="cinder-schema-view__caption">{caption}</p>
      {/if}
    </div>
  {:else}
    <p class="cinder-schema-view__empty">{emptyLabel}</p>
  {/if}
  <Collapsible variant="flat" animated={false} trigger={rawLabel} class="cinder-schema-view__raw">
    <div class="cinder-schema-view__document">
      <JsonViewer value={schema} initialDepth={2} />
    </div>
  </Collapsible>
</section>
