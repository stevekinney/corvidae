<script lang="ts" module>
  export type { DropdownTriggerProps } from './dropdown-trigger.types.ts';
</script>

<script lang="ts">
  import type { DropdownTriggerProps } from './dropdown-trigger.types.ts';

  import {
    getStaleRegionContext,
    isStaleInert,
    mergeDescribedBy,
  } from '../../_internal/stale-region-context.ts';
  import {
    getActionEmphasisContext,
    resolveActionSize,
    resolveActionVariant,
  } from '../../_internal/action-emphasis-context.ts';
  import { getButtonGroupContext } from '../../_internal/button-group-context.ts';
  import { CONTROL_SIZE_NAMES } from '../../_internal/control-size-names.ts';
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
    iconOnly = false,
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
  //
  // Inside a header's actions (COR-2489) the trigger is drawn as a Button at the row's compact
  // size, as every Button there is, so a menu beside 24px buttons is not a 32px pill; without a
  // variant of its own it takes `secondary`, the bordered face it has outside a header.
  const buttonGroup = getButtonGroupContext();
  const actionEmphasis = getActionEmphasisContext();
  const compact = $derived(actionEmphasis?.compact === true);
  type SiblingLook = { variant: ButtonVariant | undefined; size: ButtonSize | undefined };
  let siblingLook = $state<SiblingLook>({ variant: undefined, size: undefined });
  const drawsAsButton = $derived(
    buttonGroup !== undefined || variant !== undefined || size !== undefined || compact,
  );
  const resolvedVariant = $derived(
    resolveActionVariant(
      actionEmphasis,
      variant ?? siblingLook.variant ?? (compact ? 'secondary' : 'soft'),
    ),
  );
  const resolvedSize = $derived(
    resolveActionSize(actionEmphasis, size ?? siblingLook.size ?? 'md'),
  );

  /** The variant and size of the Button next to this trigger's Dropdown in its group. */
  function readSiblingLook(node: HTMLButtonElement): SiblingLook {
    const item = node.closest('.cinder-dropdown') ?? node;
    for (const neighbour of [item.previousElementSibling, item.nextElementSibling]) {
      const button = neighbour?.matches('.cinder-button:not(.cinder-dropdown-trigger)')
        ? neighbour
        : neighbour?.querySelector('.cinder-button:not(.cinder-dropdown-trigger)');
      if (!(button instanceof HTMLElement)) continue;
      const variantClass = [...button.classList].find((name) => name.startsWith('button-variant-'));
      const siblingSize = Object.entries(CONTROL_SIZE_NAMES).find(([, name]) =>
        button.classList.contains(`button-size-${name}`),
      )?.[0] as ButtonSize | undefined;
      return {
        variant: variantClass?.slice('button-variant-'.length) as ButtonVariant | undefined,
        size: siblingSize,
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
  class={classNames(
    'cinder-dropdown-trigger',
    drawsAsButton && 'cinder-button',
    drawsAsButton && `button-variant-${resolvedVariant}`,
    drawsAsButton && `button-size-${CONTROL_SIZE_NAMES[resolvedSize]}`,
    customClassName,
  )}
  data-cinder-compact={compact ? '' : undefined}
  data-cinder-hit-target={compact ? '44' : undefined}
  data-cinder-icon-only={iconOnly ? '' : undefined}
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
