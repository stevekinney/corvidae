<script lang="ts" module>
  export type { CopyableValueProps } from './copyable-value.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import CopyButton from '../copy-button/copy-button.svelte';
  import { splitValue } from './copyable-value-parts.ts';
  import type { CopyableValueProps } from './copyable-value.types.ts';

  let {
    value,
    breakHints = false,
    label,
    copiedLabel,
    class: className,
    ...rest
  }: CopyableValueProps = $props();

  // An address has no spaces, so the places it may break are its own punctuation (see
  // `copyable-value-parts.ts`): a part ends after a slash, colon, question mark, ampersand or equals
  // sign, and a part with dots in it is cut again into pieces that end after a dot. Each part and
  // each piece is drawn as a box that never breaks inside itself unless it is longer than the line,
  // so a host, a port and a file name stay whole. A line may end between two boxes without any
  // space between them, and the text is the text, so it reads and copies whole.
  const parts = $derived(splitValue(value));
  const hintedParts = $derived(value.split(/(?<=[.@-])|(?<=[:/])(?!\/)/));
</script>

<!-- The last character travels with the button in one stretch that never breaks, so wherever the
     value breaks, the button follows its last character onto the same line. Whole code points,
     never half of a surrogate pair. -->
{#snippet run(piece: string, final: boolean)}
  {#if final}
    {@const characters = Array.from(piece)}
    {characters.slice(0, -1).join('')}<span class="cinder-copyable-value__end"
      >{characters.at(-1) ?? ''}<span class="cinder-copyable-value__control"
        ><CopyButton
          appearance="inline"
          {value}
          {...label === undefined ? {} : { label }}
          {...copiedLabel === undefined ? {} : { copiedLabel }}
        /></span
      ></span
    >
  {:else}
    {piece}
  {/if}
{/snippet}

<!-- No whitespace between the parts: a space there is a place to break. -->
<span
  {...rest}
  class={classNames('cinder-copyable-value', className)}
  data-cinder-break-hints={breakHints ? '' : undefined}
  >{#if breakHints}{#each hintedParts as part, index (index)}{@render run(
        part,
        index === hintedParts.length - 1,
      )}{#if index < hintedParts.length - 1}<wbr
        />{/if}{/each}{:else}{#each parts as pieces, partIndex (partIndex)}<span
        class="cinder-copyable-value__part"
        >{#each pieces as piece, pieceIndex (pieceIndex)}{#if pieces.length > 1}<span
              class="cinder-copyable-value__piece"
              >{@render run(
                piece,
                partIndex === parts.length - 1 && pieceIndex === pieces.length - 1,
              )}</span
            >{:else}{@render run(piece, partIndex === parts.length - 1)}{/if}{/each}</span
      >{/each}{/if}</span
>
