<script lang="ts" module>
  export type { ShortcutHintProps } from './shortcut-hint.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import Kbd from '../kbd/kbd.svelte';
  import type { ShortcutHintProps } from './shortcut-hint.types.ts';

  let {
    keys,
    keysLabel,
    children,
    keysPosition = 'after',
    class: customClassName,
    ...rest
  }: ShortcutHintProps = $props();

  /**
   * Build a screen-reader–friendly label for the key combo.
   */
  const resolvedKeysLabel = $derived(keysLabel ?? keys.join(' plus '));
</script>

<!--
  The visual keycaps are aria-hidden so assistive technology never encounters the
  raw Kbd glyphs; the spoken representation is a single cinder-sr-only text node
  ("Ctrl plus S") — a more reliable strategy than aria-label on a generic span.
  Keycaps are inlined (not a {#snippet}) to avoid a Svelte 5 + happy-dom snippet
  ordering quirk when a snippet is the first child of an {#if} branch.
-->
<span {...rest} class={classNames('cinder-shortcut-hint', customClassName)}>
  {#if children && keysPosition === 'after'}
    <span class="cinder-shortcut-hint__label">{@render children()}</span>
  {/if}

  <span class="cinder-shortcut-hint__keys" aria-hidden="true">
    {#each keys as key, index (`${key}-${index}`)}
      <Kbd label={key} size="sm" />
      {#if index < keys.length - 1}
        <span class="cinder-shortcut-hint__separator">+</span>
      {/if}
    {/each}
  </span>
  <span class="cinder-sr-only">{resolvedKeysLabel}</span>

  {#if children && keysPosition === 'before'}
    <span class="cinder-shortcut-hint__label">{@render children()}</span>
  {/if}
</span>
