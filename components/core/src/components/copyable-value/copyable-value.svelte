<script lang="ts" module>
  export type { CopyableValueProps } from './copyable-value.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import CopyButton from '../copy-button/copy-button.svelte';
  import type { CopyableValueProps } from './copyable-value.types.ts';

  let { value, label, copiedLabel, class: className, ...rest }: CopyableValueProps = $props();

  // The last character travels with the button in one stretch that never breaks, so wherever the
  // value breaks, the button follows its last character onto the same line. Whole code points,
  // never half of a surrogate pair.
  const characters = $derived(Array.from(value));
  const head = $derived(characters.slice(0, -1).join(''));
  const last = $derived(characters.at(-1) ?? '');
</script>

<!-- No whitespace between the parts: a space there is a place to break. -->
<span {...rest} class={classNames('cinder-copyable-value', className)}
  >{head}<span class="cinder-copyable-value__end"
    >{last}<span class="cinder-copyable-value__control"
      ><CopyButton
        {value}
        {...label === undefined ? {} : { label }}
        {...copiedLabel === undefined ? {} : { copiedLabel }}
      /></span
    ></span
  ></span
>
