<script lang="ts" module>
  /** Props of the internal scalar writer. Not part of the public API. */
  export type PayloadScalarProps = {
    /** The property name, or the 1-based position in an array. */
    fieldKey: string;
    /** The stored value. */
    value: unknown;
    /** Property names from the payload root down to this value. */
    path: string[];
    /** What the card passes down to every part of the Fields view. */
    options: FieldsOptions;
    /** True in a table cell, where text never clamps and a link keeps the cell's height. */
    compact?: boolean;
  };
</script>

<script lang="ts">
  import type { FieldsOptions } from './payload-inspector-model.ts';

  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { describeScalar, isLongText } from './payload-inspector-model.ts';
  import { isIdentifierField } from './payload-inspector-fields.ts';
  import { SECRET_MASK } from './payload-inspector-secrets.ts';

  let { fieldKey, value, path, options, compact = false }: PayloadScalarProps = $props();

  const field = $derived({ path, key: fieldKey, value });
  const override = $derived(options.formatValue?.(field));
  const display = $derived(describeScalar(value, override));
  const href = $derived(display.kind === 'text' ? options.linkFor?.(field) : undefined);
  const clamps = $derived(
    !compact && override === undefined && display.kind === 'text' && isLongText(value),
  );
  let expanded = $state(false);
  const clampId = $props.id();
</script>

{#if display.kind === 'secret'}
  <span class="cinder-payload-inspector__secret">
    <span aria-hidden="true">{SECRET_MASK}</span>
    <span class="cinder-payload-inspector__hidden-word">Hidden</span>
  </span>
{:else if display.kind === 'none'}
  <span class="cinder-payload-inspector__null">None</span>
{:else if display.kind === 'empty'}
  <span class="cinder-payload-inspector__null">Empty</span>
{:else if href !== undefined}
  <a
    class="cinder-payload-inspector__link"
    data-cinder-identifier={isIdentifierField(fieldKey, value) || undefined}
    {href}>{display.kind === 'text' ? display.text : ''}</a
  >
{:else if display.kind === 'number'}
  <span class="cinder-payload-inspector__number">{display.text}</span>
{:else if clamps}
  <span class="cinder-payload-inspector__clamped">
    <span
      id={clampId}
      class="cinder-payload-inspector__clamp-text"
      data-cinder-clamped={!expanded || undefined}
      >{display.kind === 'text' ? display.text : ''}</span
    >
    <button
      type="button"
      class="cinder-payload-inspector__show-all"
      aria-expanded={expanded}
      aria-controls={clampId}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? 'Show less' : 'Show all'}
      <ChevronDown
        class="cinder-icon-sm"
        aria-hidden="true"
        data-cinder-open={expanded || undefined}
      />
    </button>
  </span>
{:else if display.kind === 'text' && override === undefined && isIdentifierField(fieldKey, value)}
  <code class="cinder-payload-inspector__identifier">{display.text}</code>
{:else if display.kind === 'text'}
  <span class="cinder-payload-inspector__text">{display.text}</span>
{/if}
