<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Button-shaped trigger that opens a dropdown menu, optionally rendering a trailing disclosure caret.
   * @tag form
   * @tag trigger
   * @useWhen Opening a dropdown-menu from a button styled to match cinder's form controls.
   * @useWhen Pairing with dropdown to expose a custom menu from a labelled affordance.
   * @avoidWhen Triggering a discrete action with no menu — use button instead.
   * @related dropdown, dropdown-menu
   */
  export type { DropdownTriggerProps } from './dropdown-trigger.types.ts';
</script>

<script lang="ts">
  import type { DropdownTriggerProps } from './dropdown-trigger.types.ts';

  import {
    getStaleRegionContext,
    isStaleInert,
    mergeDescribedBy,
  } from '../../_internal/stale-region-context.ts';
  import { getButtonGroupContext } from '../../_internal/button-group-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ButtonSize, ButtonVariant } from '../button/button.types.ts';
  import {
    getDropdownContext,
    getDropdownRegisterTrigger,
    getDropdownSetOpen,
  } from '../dropdown/dropdown.context.ts';

  let {
    class: customClassName,
    caretVisible = true,
    variant,
    size,
    mutating = false,
    children,
    onclick,
    style: consumerStyle,
    'aria-describedby': consumerDescribedBy,
    ...rest
  }: DropdownTriggerProps = $props();

  const context = getDropdownContext();
  const registerTrigger = getDropdownRegisterTrigger();
  const setOpen = getDropdownSetOpen();

  // A menu of actions that change something (`mutating`) under a stale `<StaleRegion>` is inert
  // but still focusable: the menu does not open, the trigger carries `aria-disabled`, and the
  // region's reason describes it.
  const staleRegion = getStaleRegionContext();
  const staleInert = $derived(isStaleInert(staleRegion, mutating));
  const describedBy = $derived(
    mergeDescribedBy(consumerDescribedBy, staleInert ? staleRegion?.reasonId : undefined),
  );

  function terminated(declaration: string): string {
    const trimmed = declaration.trim();
    return trimmed.length === 0 || trimmed.endsWith(';') ? trimmed : `${trimmed};`;
  }

  const mergedStyle = $derived(
    [consumerStyle, `anchor-name: --${context.menuId};`]
      .filter((declaration): declaration is string => Boolean(declaration))
      .map(terminated)
      .join(' ') || undefined,
  );

  // A split button: inside a ButtonGroup the trigger is drawn as a Button, and takes the variant
  // and size of the Button beside it unless the page sets its own, so the two halves read as one
  // control. Outside a group it keeps its own bordered face unless the page asks for a variant.
  const buttonGroup = getButtonGroupContext();
  type SiblingLook = { variant: ButtonVariant | undefined; size: ButtonSize | undefined };
  let siblingLook = $state<SiblingLook>({ variant: undefined, size: undefined });
  const drawsAsButton = $derived(
    buttonGroup !== undefined || variant !== undefined || size !== undefined,
  );
  const resolvedVariant = $derived(variant ?? siblingLook.variant ?? 'soft');
  const resolvedSize = $derived(size ?? siblingLook.size ?? 'md');

  /** The variant and size of the Button next to this trigger's Dropdown in its group. */
  function readSiblingLook(node: HTMLButtonElement): SiblingLook {
    const item = node.closest('.cinder-dropdown') ?? node;
    for (const neighbour of [item.previousElementSibling, item.nextElementSibling]) {
      const button = neighbour?.matches('.cinder-button:not(.cinder-dropdown-trigger)')
        ? neighbour
        : neighbour?.querySelector('.cinder-button:not(.cinder-dropdown-trigger)');
      if (!(button instanceof HTMLElement)) continue;
      return {
        variant: button.dataset['cinderVariant'] as ButtonVariant | undefined,
        size: button.dataset['cinderSize'] as ButtonSize | undefined,
      };
    }
    return { variant: undefined, size: undefined };
  }

  function attachTrigger(node: HTMLButtonElement) {
    registerTrigger(node);
    if (buttonGroup !== undefined) siblingLook = readSiblingLook(node);
    return () => registerTrigger(null);
  }

  function handleClick(
    event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement },
  ): void {
    if (staleInert) {
      event.preventDefault();
      return;
    }
    if (typeof onclick === 'function') {
      onclick(event);
    }
    if (!event.defaultPrevented && !context.supportsPopover) {
      setOpen(!context.isOpen);
    }
  }
</script>

<button
  {@attach attachTrigger}
  type="button"
  class={classNames('cinder-dropdown-trigger', drawsAsButton && 'cinder-button', customClassName)}
  data-cinder-variant={drawsAsButton ? resolvedVariant : undefined}
  data-cinder-size={drawsAsButton ? resolvedSize : undefined}
  style={mergedStyle}
  aria-haspopup="menu"
  aria-expanded={context.isOpen}
  aria-controls={context.menuId}
  popovertarget={context.supportsPopover && !staleInert ? context.menuId : undefined}
  aria-disabled={staleInert ? 'true' : undefined}
  aria-describedby={describedBy}
  onclick={handleClick}
  {...rest}
>
  {#if children}
    {@render children()}
  {/if}
  {#if caretVisible}
    <svg
      class="cinder-dropdown-trigger__caret"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M6 8l4 4 4-4" />
    </svg>
  {/if}
</button>
