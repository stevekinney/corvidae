<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose A value in monospace, such as an address or an identifier, that breaks anywhere when its place is narrow, with a copy control that stays on the value's last line.
   * @tag copy
   * @tag clipboard
   * @tag identifier
   * @useWhen Showing an address or identifier a person copies, in a place that can be narrow, so its copy control never sits alone on a row.
   * @avoidWhen Showing a snippet or several lines of code — use code-block.
   * @avoidWhen Offering a copy control with no value beside it — use copy-button.
   * @related copy-button, code-block
   * @rationale Nearest alternative: CopyButton beside a code element — that pair wraps as two parts, and the button can land alone on a line while the value breaks above it.
   */
  export type { CopyableValueProps } from './copyable-value.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
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
