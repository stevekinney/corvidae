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
  import { copyToClipboard } from '../../utilities/clipboard.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import Button from '../button/button.svelte';
  import VisuallyHiddenLiveRegion from '../_visually-hidden-live-region.svelte';

  let {
    value,
    html,
    image,
    confirmDuration = 1500,
    label,
    copiedLabel,
    iconOnly = false,
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

  // CopyButton's native attribute surface is narrower than Button's discriminated union, but the
  // rendered element is always a button. Keep the forwarding cast at this composition boundary so
  // Button's declaration does not expand the union to an unrepresentable type.
  const buttonRest = $derived(rest as Record<string, unknown>);
</script>

{#snippet buttonContent()}
  {#if copied && confirmation}{@render confirmation()}{:else if copied && iconOnly}<Check
      class="cinder-icon-sm"
      aria-hidden="true"
    />{:else if copied}Copied{:else if children}{@render children()}{:else if iconOnly}<Copy
      class="cinder-icon-sm"
      aria-hidden="true"
    />{:else}Copy{/if}
{/snippet}

<!-- The button keeps a STABLE accessible name (it remains a "copy" control even
     while showing the confirmation). Success feedback is announced by the
     separate live region below, not via aria-live on the button — putting a live
     region on the interactive control double-announces and conflicts with the
     button role. -->
{#if iconOnly}
  <Button
    {...buttonRest}
    type="button"
    size="xs"
    variant="ghost"
    quiet={true}
    iconOnly={true}
    label={label ?? 'Copy to clipboard'}
    data-cinder-copied={copied || undefined}
    aria-label={label ?? 'Copy to clipboard'}
    onclick={handleClick}
    class={classNames('cinder-copy-button', className)}
    children={copied || !children ? buttonContent : children}
  />
{:else}
  <Button
    {...buttonRest}
    type="button"
    size="xs"
    variant="secondary"
    iconOnly={false}
    label={label ?? 'Copy to clipboard'}
    data-cinder-copied={copied || undefined}
    aria-label={label ?? 'Copy to clipboard'}
    onclick={handleClick}
    class={classNames('cinder-copy-button', className)}
    children={copied || !children ? buttonContent : children}
  />
{/if}

<!-- Dedicated polite live region: announces the copy confirmation exactly once
     per successful copy, decoupled from the interactive button. -->
<VisuallyHiddenLiveRegion message={copiedAnnouncement} />
