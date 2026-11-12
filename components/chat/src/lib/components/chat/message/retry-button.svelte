<script lang="ts" module>
  export type RetryButtonProps = {
    /** What the button says, and its accessible name. Default `Retry`. */
    label?: string | undefined;
    /** Draws the retry glyph alone, for a dense row; the label stays its accessible name. */
    iconOnly?: boolean | undefined;
    /** Names what retries when the visible label alone would not, such as the image's name. */
    ariaLabel?: string | undefined;
    class?: string | undefined;
    onclick: () => void;
  };
</script>

<script lang="ts">
  import { Button, RotateCcw } from '@lostgradient/cinder';

  let {
    label = 'Retry',
    iconOnly = false,
    ariaLabel,
    class: className,
    onclick,
  }: RetryButtonProps = $props();
</script>

<!--
  The one recovery control inside the transcript: a small secondary button with the retry glyph
  leading its label. "Ask again" belongs to approvals alone, and a dense row may draw the glyph
  alone.
-->
{#if iconOnly}
  <Button
    type="button"
    {...className === undefined ? {} : { class: className }}
    size="sm"
    variant="secondary"
    iconOnly
    aria-label={ariaLabel ?? label}
    {onclick}
  >
    {#snippet leadingIcon()}<RotateCcw aria-hidden="true" />{/snippet}
  </Button>
{:else}
  <Button
    type="button"
    {...className === undefined ? {} : { class: className }}
    size="sm"
    variant="secondary"
    {label}
    {...ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }}
    {onclick}
  >
    {#snippet leadingIcon()}<RotateCcw aria-hidden="true" />{/snippet}
  </Button>
{/if}
