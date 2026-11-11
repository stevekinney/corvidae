<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status stable
   * @purpose Primary interactive control for triggering actions or rendering an anchor styled as a button via href.
   * @tag action
   * @tag cta
   * @useWhen Triggering a discrete action such as submit, save, or delete.
   * @useWhen Rendering a link that should look and behave like a button by passing href.
   * @avoidWhen Toggling a binary on or off state — use toggle instead.
   * @avoidWhen Selecting one of a small fixed set of options — use segmented-control instead.
   * @related button-group, copy-button
   */
  export type { ButtonProps, ButtonSize, ButtonVariant } from './button.types.ts';
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  import {
    getActionEmphasisContext,
    resolveActionSize,
    resolveActionVariant,
  } from '../../_internal/action-emphasis-context.ts';
  import { getButtonGroupContext } from '../../_internal/button-group-context.ts';
  import {
    getStaleRegionContext,
    isStaleInert,
    mergeDescribedBy,
  } from '../../_internal/stale-region-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import ShortcutHint from '../shortcut-hint/shortcut-hint.svelte';
  import type { ButtonProps } from './button.types.ts';

  // Destructured props let the Phase 4 analyzer read names + defaults straight off the AST.
  // `...rest` carries the remaining native HTML attributes through to the underlying element.
  //
  // ARIA + onclick are destructured explicitly because:
  //  - Leaving them in `rest` would cause Svelte's spread to render our internally-computed
  //    values LAST, clobbering any consumer-provided aria-disabled / aria-busy. Destructuring
  //    gives us control of the resolved value per attribute.
  //  - `onclick` must be wrapped during `loading` so the consumer handler doesn't fire — just
  //    stripping `href` blocks navigation but the click event still bubbles.
  const {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    loading = false,
    loadingStatus,
    mutating = false,
    iconOnly = false,
    quiet = false,
    leadingIcon,
    trailingIcon,
    shortcut,
    children,
    label,
    class: customClassName,
    href,
    onclick: consumerOnClick,
    'aria-disabled': consumerAriaDisabled,
    'aria-busy': consumerAriaBusy,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-expanded': ariaExpanded,
    'aria-controls': ariaControls,
    'aria-haspopup': ariaHaspopup,
    'aria-describedby': consumerDescribedBy,
    ...rest
  }: ButtonProps = $props();

  // Read during initialization (works identically during SSR) so the
  // connected-corner styling attribute is present in the very first markup a
  // <ButtonGroup> ancestor's Button children produce — see
  // button-group-context.ts and COR-459. `undefined` outside any group.
  const buttonGroupContext = getButtonGroupContext();
  const buttonGroupItemAttribute = buttonGroupContext?.groupId;

  // Prop-derived values must use `$derived` so they update when the consumer flips a prop
  // (most importantly `loading`) after the initial render.
  const mergedClassName = $derived(classNames('cinder-button', customClassName));
  // A page header with a full-page error under it draws its primary buttons as secondary, so the
  // error's own "Try again" is the only primary on the page.
  const actionEmphasis = getActionEmphasisContext();
  const resolvedVariant = $derived(resolveActionVariant(actionEmphasis, variant));
  // Inside a header's actions every button draws at `xs`, so the header keeps its title's height.
  const resolvedSize = $derived(resolveActionSize(actionEmphasis, size));
  const dataAttributes = $derived({
    'data-cinder-variant': resolvedVariant,
    'data-cinder-size': resolvedSize,
    'data-cinder-compact': actionEmphasis?.compact === true ? '' : undefined,
    'data-cinder-full-width': fullWidth ? '' : undefined,
    'data-cinder-loading': loading ? '' : undefined,
    'data-cinder-icon-only': iconOnly ? '' : undefined,
    'data-cinder-quiet': quiet && iconOnly && resolvedVariant === 'ghost' ? '' : undefined,
  });

  // When loading, force aria-disabled/aria-busy to 'true' so assistive tech always hears the
  // loading state. When not loading, preserve whatever the consumer passed so the component
  // doesn't silently erase their intent. The native `disabled` attribute is NOT set while
  // loading: `aria-disabled` keeps the button in the tab order, so focus stays where it was
  // when the press started instead of falling to the page.
  //
  // A button that changes something (`mutating`) under a stale `<StaleRegion>` is inert the same
  // way: `aria-disabled`, still focusable, and described by the region's reason. When the region
  // stops being stale the button returns by itself.
  const staleRegion = getStaleRegionContext();
  const staleInert = $derived(isStaleInert(staleRegion, mutating));
  const resolvedAriaDisabled = $derived(loading || staleInert ? 'true' : consumerAriaDisabled);
  const resolvedDescribedBy = $derived(
    mergeDescribedBy(consumerDescribedBy, staleInert ? staleRegion?.reasonId : undefined),
  );
  // A button that is aria-disabled (loading, or inert because the page says why) is focusable
  // but does nothing: the press is ignored, whoever set the attribute.
  const inert = $derived(
    loading || resolvedAriaDisabled === true || resolvedAriaDisabled === 'true',
  );

  // Loading keeps the button as wide as it was just before when its words stay the same: the
  // spinner takes the leading icon's place (or sits ahead of the label, using the button's own
  // padding), so the box does not grow and the layout around it does not move. `$effect.pre`
  // runs before the DOM update, so `offsetWidth` is still the resting width on the render that
  // flips `loading`. When the same update also changes the words and the new ones do not fit
  // the old width ("Create" becomes "Creating…"), the pin is let go so the label never spills
  // over the border.
  let element = $state<HTMLElement | null>(null);
  let restingWidth = $state<number | undefined>(undefined);
  let restingText: string | undefined;
  let pinReleased = $state(false);
  const lockedInlineSize = $derived(
    restingWidth === undefined || pinReleased ? undefined : `${restingWidth}px`,
  );
  $effect.pre(() => {
    if (!loading) {
      restingWidth = undefined;
      restingText = undefined;
      pinReleased = false;
      return;
    }
    if (restingWidth === undefined && element && !fullWidth) {
      const measured = element.offsetWidth;
      if (measured > 0) {
        restingWidth = measured;
        restingText = element.textContent ?? '';
      }
    }
  });
  $effect(() => {
    // Read after the DOM has updated, and again whenever the words change while loading.
    void label;
    void children;
    if (!loading || restingWidth === undefined || !element || pinReleased) return;
    if ((element.textContent ?? '') === restingText) return;
    // The words changed with `loading`. Shorter words (Test connection, Testing…) still fit the
    // pinned width, so it holds; longer ones (Create, Creating…) would spill over the border, so
    // the pin is let go and the button takes the width its content needs.
    const pinned = element.style.inlineSize;
    element.style.inlineSize = '';
    const needed = element.offsetWidth;
    element.style.inlineSize = pinned;
    if (needed > restingWidth) pinReleased = true;
  });
  const resolvedAriaBusy = $derived(loading ? 'true' : consumerAriaBusy);

  // Normalize ARIA label props: an empty string `aria-label=""` suppresses text-content fallback
  // in the accessible-name computation (ARIA spec §4.3) without providing a name. Convert empty
  // strings to `undefined` so the DOM attribute is omitted and the fallback (sr-only label text,
  // or button text content) remains the accessible name. Guards and sr-only suppression use the
  // normalized values for consistency.
  const resolvedAriaLabel = $derived(
    typeof ariaLabel === 'string' && ariaLabel.trim().length > 0 ? ariaLabel : undefined,
  );
  const resolvedAriaLabelledBy = $derived(
    typeof ariaLabelledBy === 'string' && ariaLabelledBy.trim().length > 0
      ? ariaLabelledBy
      : undefined,
  );

  // `rest` is typed as the union of both branches' attribute sets minus the keys we
  // destructured. TypeScript can't narrow a destructured remainder per branch, so each
  // template arm casts `rest` to the attribute shape its element actually accepts. The cast
  // is safe because the `#if href !== undefined` discriminant has already chosen the branch.
  // Keep the casts derived so the template spreads follow consumer prop changes.
  const anchorAttributes = $derived(
    rest as Omit<
      HTMLAnchorAttributes,
      | 'class'
      | 'href'
      | 'tabindex'
      | 'onclick'
      | 'aria-disabled'
      | 'aria-busy'
      | 'aria-label'
      | 'aria-labelledby'
      | 'aria-expanded'
      | 'aria-controls'
      | 'aria-haspopup'
      | 'aria-describedby'
    >,
  );
  const buttonAttributes = $derived(
    rest as Omit<
      HTMLButtonAttributes,
      | 'class'
      | 'type'
      | 'disabled'
      | 'onclick'
      | 'aria-disabled'
      | 'aria-busy'
      | 'aria-label'
      | 'aria-labelledby'
      | 'aria-expanded'
      | 'aria-controls'
      | 'aria-haspopup'
      | 'aria-describedby'
    >,
  );

  // Branch-specific prop reads stay `$derived` because they extract a *value* off `rest`
  // (a property access snapshots, unlike the spread of `rest` itself which re-reads the
  // reactive proxy). Keeping these derived ensures consumer `tabindex` / `type` / `disabled`
  // changes after mount still propagate to the rendered attributes.
  const anchorTabIndex = $derived(
    (rest as { tabindex?: HTMLAnchorAttributes['tabindex'] }).tabindex,
  );
  const buttonType = $derived((rest as { type?: HTMLButtonAttributes['type'] }).type);
  const buttonDisabled = $derived((rest as { disabled?: boolean }).disabled ?? false);

  type ButtonOrAnchorClickHandler = (
    event: MouseEvent & {
      currentTarget: EventTarget & (HTMLButtonElement | HTMLAnchorElement);
    },
  ) => void;

  /**
   * Wrap the consumer's onclick so it doesn't fire while the button is inert (loading, or
   * `aria-disabled`). `preventDefault()` blocks
   * the browser's default navigation on anchor left-clicks; stripping `href` in the template
   * (for every inert anchor, whoever set `aria-disabled`) handles middle-click, Ctrl-click,
   * "Open in new tab" and drag. Not calling `stopPropagation()` on
   * purpose — unrelated ancestor handlers (analytics, form listeners) should still see the
   * event; only the consumer's own button handler is skipped.
   */
  function handleClick(
    event: MouseEvent & {
      currentTarget: EventTarget & (HTMLButtonElement | HTMLAnchorElement);
    },
  ): void {
    if (inert) {
      event.preventDefault();
      return;
    }
    if (typeof consumerOnClick === 'function') {
      (consumerOnClick as ButtonOrAnchorClickHandler)(event);
    }
  }

  // Dev-mode guards. devWarn no-ops in production (bundler DCE strips the call when DEV=false).
  // Guards run reactively so prop changes after mount also surface issues.
  const hasExplicitName = $derived(
    (typeof label === 'string' && label.trim().length > 0) ||
      resolvedAriaLabel !== undefined ||
      resolvedAriaLabelledBy !== undefined,
  );

  $effect(() => {
    // Guard 1 — Updated baseline: warn when the button has no accessible name at all.
    // Use the normalized resolved values so an empty aria-label="" doesn't falsely satisfy the check.
    if (!hasExplicitName && !children) {
      devWarn(
        '[cinder/Button] rendered without an accessible name — pass a non-empty `label`, `children`, `aria-label`, or `aria-labelledby`.',
      );
    }

    // Guard 2 — icon-only accessible name: children alone does not count because it may be a
    // non-text SVG. Requires aria-label, aria-labelledby, or a non-empty label string.
    if (iconOnly && !hasExplicitName) {
      devWarn(
        '[cinder/Button] iconOnly=true requires aria-label, aria-labelledby, or a non-empty label.',
      );
    }

    // Guard 3 — icon-only visual: a blank square is a real UI failure, not just an a11y issue.
    if (iconOnly && !leadingIcon && !trailingIcon && !children) {
      devWarn(
        '[cinder/Button] iconOnly=true requires a visible icon — pass leadingIcon, trailingIcon, or children.',
      );
    }
  });
</script>

{#snippet buttonContent()}
  {#if leadingIcon}
    <span class="cinder-button__icon" aria-hidden="true">{@render leadingIcon()}</span>
  {/if}
  {#if iconOnly}
    {#if !resolvedAriaLabel && !resolvedAriaLabelledBy && label}
      <span class="cinder-sr-only">{label}</span>
    {/if}
    {#if children}
      <span class="cinder-button__icon" aria-hidden="true">{@render children()}</span>
    {/if}
  {:else if children}
    {@render children()}
  {:else}
    {label}
  {/if}
  {#if trailingIcon}
    <span class="cinder-button__icon" aria-hidden="true">{@render trailingIcon()}</span>
  {/if}
  {#if shortcut !== undefined && !iconOnly}
    <span class="cinder-button__shortcut" aria-hidden="true">
      <ShortcutHint keys={Array.isArray(shortcut) ? shortcut : [shortcut]} />
    </span>
  {/if}
{/snippet}

{#if href !== undefined}
  <a
    bind:this={element}
    {...anchorAttributes}
    href={inert ? undefined : href}
    role={inert && !loading ? 'link' : undefined}
    tabindex={loading ? -1 : inert ? 0 : anchorTabIndex}
    class={mergedClassName}
    {...dataAttributes}
    data-cinder-button-group-item={buttonGroupItemAttribute}
    style:inline-size={lockedInlineSize}
    aria-disabled={resolvedAriaDisabled}
    aria-busy={resolvedAriaBusy}
    aria-label={resolvedAriaLabel}
    aria-labelledby={resolvedAriaLabelledBy}
    aria-expanded={ariaExpanded}
    aria-controls={ariaControls}
    aria-haspopup={ariaHaspopup}
    aria-describedby={resolvedDescribedBy}
    onclick={handleClick}
  >
    {@render buttonContent()}
  </a>
{:else}
  <button
    bind:this={element}
    {...buttonAttributes}
    type={buttonType ?? 'button'}
    class={mergedClassName}
    {...dataAttributes}
    data-cinder-button-group-item={buttonGroupItemAttribute}
    style:inline-size={lockedInlineSize}
    disabled={buttonDisabled}
    aria-disabled={resolvedAriaDisabled}
    aria-busy={resolvedAriaBusy}
    aria-label={resolvedAriaLabel}
    aria-labelledby={resolvedAriaLabelledBy}
    aria-expanded={ariaExpanded}
    aria-controls={ariaControls}
    aria-haspopup={ariaHaspopup}
    aria-describedby={resolvedDescribedBy}
    onclick={handleClick}
  >
    {@render buttonContent()}
  </button>
{/if}
{#if loadingStatus !== undefined}
  <!-- Always mounted once the prop is given, so the live region is registered before its text
       is set: a freshly mounted aria-live node is not reliably announced. A sibling of the
       button, never inside it, so the status is not folded into the button's accessible name. -->
  <span class="cinder-sr-only" role="status" aria-live="polite" data-cinder-button-status
    >{loading ? loadingStatus : ''}</span
  >
{/if}
