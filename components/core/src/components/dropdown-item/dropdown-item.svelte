<script lang="ts" module>
  export type {
    DropdownItemAnchorProps,
    DropdownItemButtonProps,
    DropdownItemProps,
    DropdownItemVariant,
  } from './dropdown-item.types.ts';
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  import type { DropdownItemProps } from './dropdown-item.types.ts';

  import { classNames } from '../../utilities/class-names.ts';
  import { rowDividerAttachment } from '../../utilities/row-divider.ts';
  import { getDropdownContext } from '../dropdown/dropdown.context.ts';

  let {
    variant = 'default',
    itemRole = 'menuitem',
    checked = false,
    inset = false,
    disabled,
    disabledReason,
    closeOnSelect = true,
    class: customClassName,
    onclick,
    onkeydown,
    href,
    children,
    ...rest
  }: DropdownItemProps = $props();

  const context = getDropdownContext();

  const isLink = $derived(href !== undefined);

  // A disabled item says why on a second line, and names that line as its description; the label
  // alone is its name. An enabled item, or one with no reason, keeps its single-line markup.
  const generatedId = $props.id();
  const labelId = `${generatedId}-label`;
  const reasonId = `${generatedId}-reason`;
  const reasonText = $derived(disabled ? disabledReason?.trim() || undefined : undefined);
  const ownLabel = $derived(
    (rest as Record<string, unknown>)['aria-label'] !== undefined ||
      (rest as Record<string, unknown>)['aria-labelledby'] !== undefined,
  );
  const describedBy = $derived.by(() => {
    const own = (rest as Record<string, unknown>)['aria-describedby'];
    const ids = [typeof own === 'string' ? own : undefined, reasonText ? reasonId : undefined];
    return ids.filter((value) => value !== undefined && value !== '').join(' ') || undefined;
  });

  /**
   * Starts the reason line where the label's text starts, past a leading icon of any size, by
   * measuring the label's first text against the label (the start edge in either direction).
   */
  function alignReason(reason: HTMLElement): (() => void) | undefined {
    const label = reason.previousElementSibling;
    if (!(label instanceof HTMLElement)) return undefined;
    const measure = () => {
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      });
      const text = walker.nextNode();
      const labelBox = label.getBoundingClientRect();
      if (text === null || labelBox.width === 0) return;
      const range = document.createRange();
      range.selectNodeContents(text);
      if (typeof range.getBoundingClientRect !== 'function') return;
      const textBox = range.getBoundingClientRect();
      const rightToLeft = getComputedStyle(label).direction === 'rtl';
      const indent = rightToLeft ? labelBox.right - textBox.right : textBox.left - labelBox.left;
      reason.style.setProperty('--_cinder-dropdown-item-reason-indent', `${Math.max(0, indent)}px`);
    };
    measure();
    // A closed menu lays nothing out, so the label is measured again when it is drawn.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(label);
    return () => observer?.disconnect();
  }

  const sharedClass = $derived(
    classNames(
      'cinder-_option-row',
      'cinder-_row-item',
      'cinder-dropdown-item',
      inset && 'cinder-dropdown-item--inset',
      customClassName,
    ),
  );

  type ButtonclickHandler = (
    event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ) => void;

  type AnchorClickHandler = (
    event: MouseEvent & { currentTarget: EventTarget & HTMLAnchorElement },
  ) => void;

  function handleClick(
    event: MouseEvent & { currentTarget: EventTarget & (HTMLButtonElement | HTMLAnchorElement) },
  ): void {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (typeof onclick === 'function') {
      if (isLink) {
        (onclick as AnchorClickHandler)(
          event as MouseEvent & { currentTarget: EventTarget & HTMLAnchorElement },
        );
      } else {
        (onclick as ButtonclickHandler)(
          event as MouseEvent & { currentTarget: EventTarget & HTMLButtonElement },
        );
      }
    }
    if (closeOnSelect) {
      context.close();
    }
  }

  type AnchorKeydownHandler = (
    event: KeyboardEvent & { currentTarget: EventTarget & HTMLAnchorElement },
  ) => void;

  // A native `<a>` activates on Enter but NOT Space, whereas a `<button>` (and
  // the WAI-ARIA menuitem pattern) activates on both. Without this, Space on a
  // link row would scroll the page instead of following the row — inconsistent
  // with button rows. Translate Space into an activation click on the anchor,
  // while still forwarding any consumer-provided onkeydown handler (which runs
  // first and may preventDefault to opt out of Space-to-activate).
  function handleAnchorKeydown(
    event: KeyboardEvent & { currentTarget: EventTarget & HTMLAnchorElement },
  ): void {
    if (typeof onkeydown === 'function') {
      (onkeydown as AnchorKeydownHandler)(event);
    }
    if (event.defaultPrevented) return;
    if (event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault(); // stop the page from scrolling
    if (disabled) return;
    event.currentTarget.click();
  }

  const anchorAttributes = $derived(
    rest as Omit<HTMLAnchorAttributes, 'class' | 'href' | 'onclick' | 'onkeydown'>,
  );
  const buttonAttributes = $derived(
    rest as Omit<HTMLButtonAttributes, 'class' | 'type' | 'disabled' | 'onclick'>,
  );
  const buttonType = $derived((rest as { type?: HTMLButtonAttributes['type'] }).type ?? 'button');
  const ariaChecked = $derived(
    itemRole === 'menuitemcheckbox' || itemRole === 'menuitemradio' ? checked : undefined,
  );
</script>

<!--
  {...rest} is spread BEFORE the component-controlled attributes so a consumer
  cannot override the menu role, tabindex (the parent DropdownMenu owns the roving tabindex), aria-disabled,
  or the click handler — overriding any of those would break menu semantics.
-->
{#snippet content()}
  {#if reasonText}
    <span id={labelId} class="cinder-dropdown-item__label">
      {#if children}
        {@render children()}
      {/if}
    </span>
    <span id={reasonId} class="cinder-dropdown-item__reason" {@attach alignReason}>
      {reasonText}
    </span>
  {:else if children}
    {@render children()}
  {/if}
{/snippet}

{#if isLink}
  <a
    {@attach rowDividerAttachment}
    {...anchorAttributes}
    {href}
    role={itemRole}
    aria-checked={ariaChecked}
    class={sharedClass}
    data-cinder-variant={variant}
    tabindex={-1}
    data-disabled={disabled ? '' : undefined}
    data-cinder-reason={reasonText ? '' : undefined}
    aria-disabled={disabled ? 'true' : undefined}
    aria-labelledby={reasonText && !ownLabel ? labelId : anchorAttributes['aria-labelledby']}
    aria-describedby={describedBy}
    onclick={handleClick}
    onkeydown={handleAnchorKeydown}
  >
    {@render content()}
  </a>
{:else}
  <button
    {@attach rowDividerAttachment}
    {...buttonAttributes}
    type={buttonType}
    role={itemRole}
    aria-checked={ariaChecked}
    class={sharedClass}
    data-cinder-variant={variant}
    tabindex={-1}
    data-disabled={disabled ? '' : undefined}
    data-cinder-reason={reasonText ? '' : undefined}
    aria-disabled={disabled ? 'true' : undefined}
    aria-labelledby={reasonText && !ownLabel ? labelId : buttonAttributes['aria-labelledby']}
    aria-describedby={describedBy}
    onclick={handleClick}
    {onkeydown}
  >
    {@render content()}
  </button>
{/if}
