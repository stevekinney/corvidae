<script lang="ts" module>
  /** Props of the internal Fields view. Not part of the public API. */
  export type PayloadFieldsProps = {
    /** The object or array to list. */
    source: unknown;
    /** Property names from the payload root down to `source`. */
    path: string[];
    /** How many levels of nesting lie above `source`. */
    depth: number;
    /** What the card passes down to every part of the Fields view. */
    options: FieldsOptions;
    /** How an object's pairs read. Only the payload's own object chooses anything but rows. */
    layout?: FieldsLayout;
    /** The key whose value is still arriving, shown as "Receiving…". */
    pendingKey?: string | undefined;
    /** The array's label, which names a table for assistive technology. */
    caption?: string;
  };
</script>

<script lang="ts">
  import type { FieldsLayout, FieldsOptions } from './payload-inspector-model.ts';

  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { SvelteMap } from 'svelte/reactivity';
  import InlineLoading from '../inline-loading/inline-loading.svelte';
  import SourceDiffViewer from '../source-diff-viewer/source-diff-viewer.svelte';
  import { countPatchChanges } from '../source-diff-viewer/source-diff-viewer.utilities.ts';
  import Tooltip from '../tooltip/tooltip.svelte';
  import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
  import { readPayloadEntries, isUnifiedPatch } from './payload-inspector-fields.ts';
  import {
    classifyArray,
    describeContents,
    describeLongKey,
    describeScalar,
    LONG_KEY_LENGTH,
  } from './payload-inspector-model.ts';
  import Self from './_payload-fields.svelte';
  import PayloadScalar from './_payload-scalar.svelte';
  import PayloadTable from './_payload-table.svelte';

  let {
    source,
    path,
    depth,
    options,
    layout = 'rows',
    pendingKey,
    caption = '',
  }: PayloadFieldsProps = $props();

  // How many entries of one object or array render before the rest are summarised, so a very
  // wide payload cannot build an unbounded DOM.
  const ENTRY_LIMIT = 100;

  const entries = $derived(Array.isArray(source) ? [] : readPayloadEntries(source));

  // A nested value the reader opened or closed. Anything not in the map follows its default.
  const toggled = new SvelteMap<string, boolean>();

  function defaultOpen(value: unknown): boolean {
    return !Array.isArray(value) && depth < options.initialDepth;
  }

  function isOpen(key: string, value: unknown): boolean {
    if (!options.tree) return true;
    return toggled.get(key) ?? defaultOpen(value);
  }

  function labelFor(key: string): string {
    return humanizeIdentifier(key, { casing: 'sentence' });
  }

  function valueOf(entry: { key: string; value: unknown }): string {
    const display = describeScalar(
      entry.value,
      options.formatValue?.({ path: [...path, entry.key], key: entry.key, value: entry.value }),
    );
    return display.kind === 'text' || display.kind === 'number' ? display.text : '';
  }
</script>

{#snippet keyLabel(key: string)}
  {@const text = labelFor(key)}
  {#if key.length > LONG_KEY_LENGTH}
    <Tooltip text={describeLongKey(key)} placement="top">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- the label is cut to one line, so a keyboard user focuses it to read the whole key in its tooltip. -->
      <span class="cinder-payload-inspector__long-key" tabindex="0">{text}</span>
    </Tooltip>
  {:else}
    {text}
  {/if}
{/snippet}

{#snippet arrayBody(
  items: unknown[],
  itemsPath: string[],
  itemsCaption: string,
  itemsDepth: number,
)}
  {@const shape = classifyArray(items)}
  {#if shape === 'empty'}
    <span class="cinder-payload-inspector__null">No items</span>
  {:else if itemsDepth > options.maxDepth}
    <span class="cinder-payload-inspector__null">Too deep to show here.</span>
  {:else if shape === 'scalars'}
    <ul class="cinder-payload-inspector__list">
      {#each items.slice(0, ENTRY_LIMIT) as item, index (index)}
        <li>
          <PayloadScalar
            fieldKey={String(index + 1)}
            value={item}
            path={[...itemsPath, String(index + 1)]}
            {options}
          />
        </li>
      {/each}
    </ul>
    {#if items.length > ENTRY_LIMIT}
      <p class="cinder-payload-inspector__more">
        {items.length - ENTRY_LIMIT} more not shown. Switch to JSON to see them.
      </p>
    {/if}
  {:else if shape === 'uniform'}
    <PayloadTable
      rows={items as Record<string, unknown>[]}
      path={itemsPath}
      caption={itemsCaption}
      {options}
    />
  {:else}
    <div class="cinder-payload-inspector__items">
      {#each items.slice(0, ENTRY_LIMIT) as item, index (index)}
        <div class="cinder-payload-inspector__item">
          <p class="cinder-payload-inspector__item-title">Item {index + 1} of {items.length}</p>
          {#if Array.isArray(item)}
            {@render arrayBody(
              item,
              [...itemsPath, String(index + 1)],
              itemsCaption,
              itemsDepth + 1,
            )}
          {:else if item !== null && typeof item === 'object' && !(item instanceof Date)}
            <Self
              source={item}
              path={[...itemsPath, String(index + 1)]}
              depth={itemsDepth + 1}
              {options}
              caption={itemsCaption}
            />
          {:else}
            <PayloadScalar
              fieldKey={String(index + 1)}
              value={item}
              path={[...itemsPath, String(index + 1)]}
              {options}
            />
          {/if}
        </div>
      {/each}
    </div>
    {#if items.length > ENTRY_LIMIT}
      <p class="cinder-payload-inspector__more">
        {items.length - ENTRY_LIMIT} more not shown. Switch to JSON to see them.
      </p>
    {/if}
  {/if}
{/snippet}

{#if Array.isArray(source)}
  {@render arrayBody(source, path, caption, depth)}
{:else if entries.length === 0 && pendingKey === undefined}
  <span class="cinder-payload-inspector__null">No fields</span>
{:else if layout === 'inline'}
  <p
    class="cinder-payload-inspector__inline"
    data-cinder-layout="inline"
    title={entries.map((entry) => `${labelFor(entry.key)} ${valueOf(entry)}`).join(' · ')}
  >
    {#each entries as entry, index (entry.key)}
      {#if index > 0}<span aria-hidden="true">{' · '}</span>{/if}<span
        class="cinder-payload-inspector__inline-pair"
        ><span class="cinder-payload-inspector__field-label">{labelFor(entry.key)}</span
        >{' '}<strong class="cinder-payload-inspector__inline-value"
          ><PayloadScalar
            fieldKey={entry.key}
            value={entry.value}
            path={[...path, entry.key]}
            {options}
            compact
          /></strong
        ></span
      >
    {/each}
  </p>
{:else}
  <dl class="cinder-payload-inspector__fields" data-cinder-layout={layout}>
    {#each entries.slice(0, ENTRY_LIMIT) as entry (entry.key)}
      {@const patch = !entry.nested && isUnifiedPatch(entry.value) ? entry.value : undefined}
      {#if entry.nested}
        {@const open = isOpen(entry.key, entry.value)}
        <div class="cinder-payload-inspector__field" data-cinder-block>
          <dt class="cinder-payload-inspector__field-label">
            {#if options.tree}
              <button
                type="button"
                class="cinder-payload-inspector__toggle"
                aria-expanded={open}
                onclick={() => toggled.set(entry.key, !open)}
              >
                {#if open}<ChevronDown
                    class="cinder-icon-sm"
                    aria-hidden="true"
                  />{:else}<ChevronRight class="cinder-icon-sm" aria-hidden="true" />{/if}
                {labelFor(entry.key)}
                <span class="cinder-payload-inspector__count">
                  · {describeContents(entry.value)}</span
                >
              </button>
            {:else}
              {labelFor(entry.key)}
              <span class="cinder-payload-inspector__count">
                · {describeContents(entry.value)}</span
              >
            {/if}
          </dt>
          {#if open}
            <dd class="cinder-payload-inspector__field-value">
              {#if depth + 1 > options.maxDepth}
                <span class="cinder-payload-inspector__null">Too deep to show here.</span>
              {:else}
                <Self
                  source={entry.value}
                  path={[...path, entry.key]}
                  depth={depth + 1}
                  {options}
                  caption={`${labelFor(entry.key)}, ${describeContents(entry.value)}`}
                />
              {/if}
            </dd>
          {/if}
        </div>
      {:else}
        <div
          class="cinder-payload-inspector__field"
          data-cinder-patch={patch !== undefined || undefined}
        >
          <dt class="cinder-payload-inspector__field-label">
            {@render keyLabel(entry.key)}
            {#if patch !== undefined}
              {@const changes = countPatchChanges(patch)}
              <span
                class="cinder-payload-inspector__patch-count"
                aria-label={`${changes.added} added, ${changes.removed} removed`}
                >+{changes.added} −{changes.removed}</span
              >
            {/if}
          </dt>
          <dd class="cinder-payload-inspector__field-value">
            {#if patch !== undefined}
              <SourceDiffViewer
                {patch}
                variant="inline"
                maxLines={2}
                ariaLabel={labelFor(entry.key)}
              />
            {:else}
              <PayloadScalar
                fieldKey={entry.key}
                value={entry.value}
                path={[...path, entry.key]}
                {options}
              />
            {/if}
          </dd>
        </div>
      {/if}
    {/each}
    {#if pendingKey !== undefined}
      <div class="cinder-payload-inspector__field">
        <dt class="cinder-payload-inspector__field-label">{labelFor(pendingKey)}</dt>
        <dd class="cinder-payload-inspector__field-value">
          <InlineLoading status="active" description="Receiving…" />
        </dd>
      </div>
    {/if}
  </dl>
  {#if entries.length > ENTRY_LIMIT}
    <p class="cinder-payload-inspector__more">
      {entries.length - ENTRY_LIMIT} more not shown. Switch to JSON to see them.
    </p>
  {/if}
{/if}
