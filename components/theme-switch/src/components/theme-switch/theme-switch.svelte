<script lang="ts" module>
  export type { ThemeSwitchProps, ThemeSwitchValue } from './theme-switch.types.ts';
</script>

<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import { handleRovingKeydown } from '@lostgradient/foundation/utilities/roving-tabindex.ts';

  import type { ThemeSwitchProps, ThemeSwitchValue } from './theme-switch.types.ts';

  const positions: readonly { value: ThemeSwitchValue; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
    { value: 'dark', label: 'Dark' },
  ];

  let {
    id,
    value = $bindable('system'),
    onValueChange,
    label = 'Theme',
    disabled = false,
    class: customClassName,
  }: ThemeSwitchProps = $props();

  const buttons = $state<(HTMLButtonElement | undefined)[]>([]);

  // A value outside the three positions (a JavaScript caller) reads as System without rewriting
  // what the caller bound.
  const selectedIndex = $derived.by(() => {
    const index = positions.findIndex((position) => position.value === value);
    return index === -1 ? 1 : index;
  });
  const selectedValue = $derived(positions[selectedIndex]?.value ?? 'system');

  function select(next: ThemeSwitchValue): void {
    if (disabled || next === selectedValue) return;
    value = next;
    onValueChange?.(next);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (disabled) return;
    const focusedIndex = buttons.findIndex((button) => button === event.target);
    const nextIndex = handleRovingKeydown(
      event,
      focusedIndex === -1 ? selectedIndex : focusedIndex,
      positions.length,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    const next = positions[nextIndex];
    if (next === undefined) return;
    // A radio group selects as focus moves, so the arrow keys, Home and End select.
    select(next.value);
    buttons[nextIndex]?.focus();
  }
</script>

<div
  {id}
  class={classNames('cinder-theme-switch', customClassName)}
  role="radiogroup"
  aria-label={label}
  aria-disabled={disabled ? 'true' : undefined}
  data-cinder-value={selectedValue}
  data-cinder-disabled={disabled ? '' : undefined}
>
  <span class="cinder-theme-switch__thumb" aria-hidden="true"></span>
  {#each positions as position, index (position.value)}
    <button
      bind:this={buttons[index]}
      type="button"
      role="radio"
      class="cinder-theme-switch__option"
      aria-checked={position.value === selectedValue}
      aria-label={position.label}
      title={position.label}
      tabindex={position.value === selectedValue ? 0 : -1}
      {disabled}
      data-cinder-position={position.value}
      onclick={() => select(position.value)}
      onkeydown={handleKeydown}
    >
      {#if position.value === 'light'}
        <Sun class="cinder-theme-switch__icon" aria-hidden="true" />
      {:else if position.value === 'system'}
        <Monitor class="cinder-theme-switch__icon" aria-hidden="true" />
      {:else}
        <Moon class="cinder-theme-switch__icon" aria-hidden="true" />
      {/if}
    </button>
  {/each}
</div>
