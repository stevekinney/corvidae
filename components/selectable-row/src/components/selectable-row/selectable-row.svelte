<script lang="ts" module>
  export type {
    SelectableRowCurrentValue,
    SelectableRowDensity,
    SelectableRowProps,
    SelectableRowSchemaProps,
    SelectableRowSelectedState,
  } from './selectable-row.types.ts';
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { SelectableRowProps } from './selectable-row.types.ts';

  let {
    density = 'comfortable',
    selected = false,
    selectedState = 'pressed',
    href,
    currentValue = 'true',
    type = 'button',
    leading,
    title,
    description,
    meta,
    trailingActions,
    class: className,
    style,
    ...rest
  }: SelectableRowProps = $props();

  const isLink = $derived(href !== undefined);
  const selectedDataAttribute = $derived(selected ? '' : undefined);
  const ariaPressed = $derived(!isLink && selectedState === 'pressed' ? selected : undefined);
  const ariaCurrent = $derived(
    selected && (isLink || selectedState === 'current') ? currentValue : undefined,
  );
  const anchorAttributes = $derived(rest as Omit<HTMLAnchorAttributes, 'class' | 'href' | 'style'>);
  const buttonAttributes = $derived(rest as Omit<HTMLButtonAttributes, 'class' | 'style' | 'type'>);
  const resolvedRel = $derived.by(() => {
    if (!isLink) return undefined;

    const consumerTokens = (anchorAttributes.rel ?? '').split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const token of consumerTokens) {
      const normalizedToken = token.toLowerCase();
      if (!seen.has(normalizedToken)) {
        seen.add(normalizedToken);
        merged.push(token);
      }
    }

    if (anchorAttributes.target?.toLowerCase() === '_blank') {
      for (const token of ['noopener', 'noreferrer']) {
        if (!seen.has(token)) {
          seen.add(token);
          merged.push(token);
        }
      }
    }

    return merged.length > 0 ? merged.join(' ') : undefined;
  });
</script>

<div
  class={classNames(
    'cinder-selectable-row',
    leading && 'cinder-selectable-row--has-leading',
    trailingActions && 'cinder-selectable-row--has-trailing-actions',
    className,
  )}
  {style}
  data-cinder-density={density}
  data-cinder-selected={selectedDataAttribute}
>
  {#if isLink}
    <a
      {...anchorAttributes}
      class="cinder-selectable-row__primary"
      {href}
      rel={resolvedRel}
      aria-current={ariaCurrent}
    >
      {#if leading}
        <span class="cinder-selectable-row__leading">{@render leading()}</span>
      {/if}
      <span class="cinder-selectable-row__body">
        <span class="cinder-selectable-row__title">{@render title()}</span>
        {#if description}
          <span class="cinder-selectable-row__description">{@render description()}</span>
        {/if}
        {#if meta}<span class="cinder-selectable-row__meta">{@render meta()}</span>{/if}
      </span>
    </a>
  {:else}
    <button
      {...buttonAttributes}
      class="cinder-selectable-row__primary"
      {type}
      aria-pressed={ariaPressed}
      aria-current={ariaCurrent}
    >
      {#if leading}
        <span class="cinder-selectable-row__leading">{@render leading()}</span>
      {/if}
      <span class="cinder-selectable-row__body">
        <span class="cinder-selectable-row__title">{@render title()}</span>
        {#if description}
          <span class="cinder-selectable-row__description">{@render description()}</span>
        {/if}
        {#if meta}<span class="cinder-selectable-row__meta">{@render meta()}</span>{/if}
      </span>
    </button>
  {/if}

  {#if trailingActions}
    <div class="cinder-selectable-row__trailing-actions">
      {@render trailingActions()}
    </div>
  {/if}
</div>
