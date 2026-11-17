<script lang="ts" module>
  export type {
    ActionRowCurrentValue,
    ActionRowProps,
    ActionRowSelectedState,
  } from './action-row.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { ActionRowProps } from './action-row.types.ts';

  let {
    selected = false,
    selectedState = 'pressed',
    currentValue = 'true',
    type = 'button',
    disabled,
    leading,
    title,
    description,
    meta,
    trailing,
    class: className,
    ...rest
  }: ActionRowProps = $props();

  const ariaPressed = $derived(selectedState === 'pressed' ? selected : undefined);
  const ariaCurrent = $derived(selectedState === 'current' && selected ? currentValue : undefined);
  const selectedDataAttribute = $derived(selected ? '' : undefined);
</script>

<button
  {...rest}
  {type}
  {disabled}
  class={classNames(
    'cinder-action-row',
    leading && 'cinder-action-row--has-leading',
    trailing && 'cinder-action-row--has-trailing',
    className,
  )}
  data-cinder-selected={selectedDataAttribute}
  aria-pressed={ariaPressed}
  aria-current={ariaCurrent}
>
  <span class="cinder-action-row__layout">
    {#if leading}
      <span class="cinder-action-row__leading">
        {@render leading()}
      </span>
    {/if}
    <span class="cinder-action-row__body">
      <span class="cinder-action-row__title">
        {@render title()}
      </span>
      {#if description}
        <span class="cinder-action-row__description">{@render description()}</span>
      {/if}
      {#if meta}
        <span class="cinder-action-row__meta">{@render meta()}</span>
      {/if}
    </span>
    {#if trailing}
      <span class="cinder-action-row__trailing">
        {@render trailing()}
      </span>
    {/if}
  </span>
</button>
