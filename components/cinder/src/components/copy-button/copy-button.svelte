<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status stable
   * @purpose Button that writes plain text plus optional rich HTML/image clipboard representations and flips to a confirmation state after success.
   * @tag action
   * @tag clipboard
   * @useWhen Offering one-click copy of a token, snippet, share link, or code sample.
   * @useWhen Pairing with code-block so readers can grab the rendered source.
   * @avoidWhen Triggering a generic non-clipboard action — use button instead.
   * @avoidWhen Copying long-form rich content that needs format preservation — handle clipboard logic directly.
   * @related button, code-block
   */
  export type { CopyButtonProps } from './copy-button.types.ts';
</script>

<script lang="ts">
  import type { CopyButtonProps } from './copy-button.types.ts';

  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import { getTooltipTriggerContext } from '../../_internal/tooltip-trigger-context.ts';
  import { copyToClipboard } from '../../utilities/clipboard.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import Tooltip from '../tooltip/tooltip.svelte';
  import VisuallyHiddenLiveRegion from '../_visually-hidden-live-region.svelte';

  let {
    value,
    html,
    image,
    confirmDuration = 1500,
    label,
    copiedLabel,
    textVisible = false,
    class: className,
    children,
    confirmation,
    onError,
    // `...rest` carries every other native button attribute (id, data-*, form, name,
    // tabindex, etc.) through to the rendered element. The component's controlled attrs
    // (aria-label, aria-live, onclick, data-cinder-copied) are Omit-ted from the prop
    // type AND rendered explicitly AFTER {...rest} below, so they always win — even if a
    // consumer bypasses the types to inject one, the later attribute on the element
    // overrides the spread value.
    ...rest
  }: CopyButtonProps = $props();

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  // Drive the announcement from a dedicated live region (below), not from
  // aria-live on the button itself. A live region on an interactive control
  // double-announces (the AT reads the button's name on focus AND as a live
  // change) and conflicts with the button role — it's an ARIA anti-pattern.
  const copiedAnnouncement = $derived(copied ? (copiedLabel ?? 'Copied') : '');
  const accessibleName = $derived(label ?? 'Copy to clipboard');
  // The Copy icon is the face; words follow it only when asked for, or when the page writes its own.
  const textFace = $derived(textVisible || children !== undefined);
  // Inside a page's own Tooltip the icon face leaves the tooltip to it, so there is only one.
  const insideTooltip = getTooltipTriggerContext() !== undefined;

  async function handleClick() {
    const richClipboardContent: { html?: string; image?: Blob | string } = {};
    if (html !== undefined) richClipboardContent.html = html;
    if (image !== undefined) richClipboardContent.image = image;
    const ok = await copyToClipboard(value, richClipboardContent);
    if (!ok) {
      devWarn('[cinder/CopyButton] Clipboard write failed.');
      onError?.();
      return;
    }
    copied = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
    }, confirmDuration);
  }

  $effect(() => {
    return () => {
      if (resetTimer) clearTimeout(resetTimer);
    };
  });
</script>

<!-- The button keeps a STABLE accessible name (it remains a "copy" control even
     while showing the confirmation). Success feedback is announced by the
     separate live region below, not via aria-live on the button — putting a live
     region on the interactive control double-announces and conflicts with the
     button role. -->
{#snippet face()}
  <button
    {...rest}
    type="button"
    data-cinder-copied={copied || undefined}
    aria-label={accessibleName}
    data-cinder-icon-only={textFace ? undefined : ''}
    onclick={handleClick}
    class={classNames('cinder-copy-button', className)}
  >
    <!-- Accessible name comes from `aria-label`. The icon is always present and decorative: Copy
         at rest, Check once copied. Visible words are presentational only; the announcement is
         owned by the live region. -->
    {#if copied}
      <Check class="cinder-icon-sm" aria-hidden="true" />
    {:else}
      <Copy class="cinder-icon-sm" aria-hidden="true" />
    {/if}
    {#if textFace}
      <!-- Both words are laid out in one cell and only the current one shows, so the button is
           as wide copied as at rest and nothing beside it moves. -->
      <span class="cinder-copy-button__words">
        <span class="cinder-copy-button__word" data-cinder-current={copied ? undefined : ''}>
          {#if children}{@render children()}{:else}Copy{/if}
        </span>
        <span class="cinder-copy-button__word" data-cinder-current={copied ? '' : undefined}>
          {#if confirmation}{@render confirmation()}{:else}Copied{/if}
        </span>
      </span>
    {/if}
  </button>
{/snippet}

{#if textFace || insideTooltip}
  {@render face()}
{:else}
  <!-- The icon-only face shows its name in a tooltip; the button is already named by it. -->
  <Tooltip text={accessibleName} describe={false}>{@render face()}</Tooltip>
{/if}

<!-- Dedicated polite live region: announces the copy confirmation exactly once
     per successful copy, decoupled from the interactive button. -->
<VisuallyHiddenLiveRegion message={copiedAnnouncement} />
