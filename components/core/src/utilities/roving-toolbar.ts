/**
 * DOM-driven roving tabindex for WAI-ARIA toolbars.
 *
 * `Toolbar` and `SelectionPopover` (when it carries caller-supplied actions) share this one
 * implementation. It manages the native focusable descendants of a root element in DOM order:
 * one item holds `tabindex="0"` (a single Tab stop), the rest get `-1`, and the arrow keys, Home
 * and End move focus between enabled items. Editable controls keep their own editing keys until
 * the caret reaches the matching boundary.
 */

import { handleRovingKeydown } from './roving-tabindex.ts';

export type RovingToolbarOptions = {
  /** The element whose focusable descendants are the toolbar items. */
  root: HTMLElement;
  /** Arrow-key axis. Defaults to horizontal. */
  orientation?: () => 'horizontal' | 'vertical';
  /** Runs first on every keydown, before roving; return after calling `preventDefault` to opt out. */
  onKeydown?: (event: KeyboardEvent) => void;
  /** Runs first on every focusin, before the active item is updated. */
  onFocusIn?: (event: FocusEvent) => void;
};

export type RovingToolbarController = {
  /** Re-derive the items and tab stops, keeping `preferredItem` (default: the current one) active. */
  sync: (preferredItem?: HTMLElement | null) => void;
  /** The first enabled item, or null when there is none. */
  firstEnabledItem: () => HTMLElement | null;
  /** The item that currently holds the Tab stop, or null. Pass it to a later controller's `sync` to keep the user's place. */
  activeItem: () => HTMLElement | null;
  /** Wire keydown (capture) and focusin on the root; returns a cleanup that also restores tabindex. */
  attach: () => () => void;
};

/**
 * Mutation observer options that cover every change which can alter which items are focusable.
 * Pass to `useMutationObserver` on the root, and call `sync` from its callback.
 */
export const ROVING_TOOLBAR_MUTATION_OPTIONS: {
  subtree: boolean;
  childList: boolean;
  attributes: boolean;
  attributeFilter: string[];
} = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: [
    'aria-disabled',
    'aria-hidden',
    'aria-label',
    'aria-labelledby',
    'class',
    'data-cinder-toolbar-exclude',
    'data-cinder-toolbar-item',
    'disabled',
    'hidden',
    'inert',
    'style',
    'type',
  ],
};

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const FOCUSABLE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[tabindex]',
  '[data-cinder-toolbar-item]',
].join(',');

function isHTMLElement(value: Element | EventTarget | null): value is HTMLElement {
  return value instanceof HTMLElement;
}

function isHiddenInput(element: HTMLElement): boolean {
  return element instanceof HTMLInputElement && element.type === 'hidden';
}

function isEditableTarget(element: HTMLElement): element is EditableElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return ![
      'button',
      'checkbox',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(element.type);
  }
  return element.isContentEditable;
}

function isSpinButtonLike(element: HTMLElement): boolean {
  if (element.getAttribute('role') === 'spinbutton') return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return element.closest('.cinder-number-input') !== null;
}

function hasCollapsedSelectionAtBoundary(element: HTMLElement, direction: -1 | 1): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (typeof element.selectionStart !== 'number' || typeof element.selectionEnd !== 'number') {
    return false;
  }
  if (element.selectionStart !== element.selectionEnd) return false;
  const valueLength = element.value.length;
  return direction === -1 ? element.selectionStart === 0 : element.selectionEnd === valueLength;
}

function placeCaret(element: HTMLElement, placement: 'start' | 'end'): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
  if (typeof element.setSelectionRange !== 'function') return;
  const position = placement === 'end' ? element.value.length : 0;
  element.setSelectionRange(position, position);
}

/**
 * Whether an ancestor is `display: none`. Deliberately narrower than the candidate's own check —
 * `visibility` is inherited and a descendant can override an ancestor's `visibility: hidden` back
 * to `visible`, so an ancestor's `visibility` alone must not veto its descendants. `display: none`
 * has no such override, so it is the only ancestor-level signal. Memoized in `hiddenCache` so an
 * ancestor shared by multiple candidates during one pass only calls `getComputedStyle` once.
 */
function isAncestorDisplayNone(element: HTMLElement, hiddenCache: Map<Element, boolean>): boolean {
  const cached = hiddenCache.get(element);
  if (cached !== undefined) return cached;
  const hidden = getComputedStyle(element).display === 'none';
  hiddenCache.set(element, hidden);
  return hidden;
}

function isDisabledByFieldset(element: HTMLElement): boolean {
  const disabledFieldset = element.closest('fieldset[disabled]');
  if (!disabledFieldset) return false;
  const firstLegend = disabledFieldset.querySelector('legend');
  return firstLegend ? !firstLegend.contains(element) : true;
}

function isDisabledToolbarItem(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled')) return true;
  if (element.getAttribute('aria-disabled') === 'true') return true;
  if ('disabled' in element && element.disabled === true) return true;
  return isDisabledByFieldset(element);
}

export function createRovingToolbar(options: RovingToolbarOptions): RovingToolbarController {
  const { root, orientation = () => 'horizontal', onKeydown, onFocusIn } = options;

  let toolbarItems: HTMLElement[] = [];
  let activeItem: HTMLElement | null = null;
  const originalTabIndexes = new WeakMap<HTMLElement, string | null>();
  let previousManagedItems = new Set<HTMLElement>();

  function isCssHidden(element: HTMLElement, hiddenCache: Map<Element, boolean>): boolean {
    const elementStyle = getComputedStyle(element);
    if (elementStyle.display === 'none' || elementStyle.visibility === 'hidden') return true;

    let current = element === root ? null : element.parentElement;
    while (current) {
      if (isAncestorDisplayNone(current, hiddenCache)) return true;
      if (current === root) break;
      current = current.parentElement;
    }
    return false;
  }

  function isToolbarItemCandidate(
    element: HTMLElement,
    hiddenCache: Map<Element, boolean> = new Map(),
  ): boolean {
    if (element === root) return false;
    if (!root.contains(element)) return false;
    if (isHiddenInput(element)) return false;
    if (element.hasAttribute('hidden')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest('[hidden],[aria-hidden="true"],[data-cinder-toolbar-exclude]')) {
      return false;
    }
    if (element.closest('[inert]')) return false;
    if (isCssHidden(element, hiddenCache)) return false;
    const authoredTabIndex = element.getAttribute('tabindex');
    if (
      authoredTabIndex === '-1' &&
      !previousManagedItems.has(element) &&
      !element.hasAttribute('data-cinder-toolbar-item')
    ) {
      return false;
    }
    return true;
  }

  function getToolbarItems(): HTMLElement[] {
    const hiddenCache = new Map<Element, boolean>();
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) =>
      isToolbarItemCandidate(element, hiddenCache),
    );
  }

  function getActiveIndex(items: HTMLElement[], preferredItem: HTMLElement | null): number {
    if (preferredItem) {
      const preferredIndex = items.indexOf(preferredItem);
      if (preferredIndex >= 0 && !isDisabledToolbarItem(preferredItem)) return preferredIndex;
    }
    return items.findIndex((item) => !isDisabledToolbarItem(item));
  }

  function restoreDepartedItems(nextItems: HTMLElement[]): void {
    const nextItemSet = new Set(nextItems);
    for (const item of previousManagedItems) {
      if (nextItemSet.has(item)) continue;
      const original = originalTabIndexes.get(item);
      if (original === null) item.removeAttribute('tabindex');
      else if (original !== undefined) item.setAttribute('tabindex', original);
      originalTabIndexes.delete(item);
    }
    previousManagedItems = nextItemSet;
  }

  function sync(preferredItem: HTMLElement | null = activeItem): void {
    const items = getToolbarItems();
    restoreDepartedItems(items);

    if (items.length === 0) {
      toolbarItems = [];
      activeItem = null;
      return;
    }

    for (const item of items) {
      if (!originalTabIndexes.has(item)) {
        originalTabIndexes.set(item, item.getAttribute('tabindex'));
      }
    }

    const activeIndex = getActiveIndex(items, preferredItem);
    const resolvedActiveItem = activeIndex >= 0 ? (items[activeIndex] ?? null) : null;

    for (const [index, item] of items.entries()) {
      const nextTabIndex = index === activeIndex ? 0 : -1;
      if (item.tabIndex !== nextTabIndex) {
        item.tabIndex = nextTabIndex;
      }
    }

    toolbarItems = items;
    activeItem = resolvedActiveItem;
  }

  function moveFocus(nextIndex: number, caretPlacement: 'start' | 'end'): void {
    const nextItem = toolbarItems[nextIndex];
    if (!nextItem) return;
    activeItem = nextItem;
    sync(nextItem);
    nextItem.focus();
    placeCaret(nextItem, caretPlacement);
  }

  function handleEditableEscape(target: HTMLElement): boolean {
    if (!isEditableTarget(target)) return false;
    const currentIndex = toolbarItems.indexOf(target);
    if (currentIndex < 0) return false;
    const forwardIndex = toolbarItems.findIndex(
      (item, index) => index > currentIndex && !isDisabledToolbarItem(item),
    );
    let nextIndex = forwardIndex;
    if (nextIndex < 0) {
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const item = toolbarItems[index];
        if (item && !isDisabledToolbarItem(item)) {
          nextIndex = index;
          break;
        }
      }
    }
    if (nextIndex < 0) return false;
    moveFocus(nextIndex, nextIndex > currentIndex ? 'start' : 'end');
    return true;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    onKeydown?.(event);
    if (event.defaultPrevented) return;
    if (!isHTMLElement(event.target)) return;

    const target = event.target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!target || !toolbarItems.includes(target)) return;

    const currentIndex = toolbarItems.indexOf(target);
    if (currentIndex < 0) return;

    const horizontal = orientation() !== 'vertical';
    const targetIsEditable = isEditableTarget(target);

    if (event.key === 'Escape' && targetIsEditable) {
      if (!handleEditableEscape(target)) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if ((event.key === 'Home' || event.key === 'End') && targetIsEditable) {
      return;
    }

    if (horizontal && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      if (
        targetIsEditable &&
        !hasCollapsedSelectionAtBoundary(target, event.key === 'ArrowLeft' ? -1 : 1)
      ) {
        return;
      }
    }

    if (!horizontal && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (targetIsEditable || isSpinButtonLike(target)) return;
    }

    if (horizontal && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      return;
    }

    if (!horizontal && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      return;
    }

    const nextIndex = handleRovingKeydown(event, currentIndex, toolbarItems.length, {
      horizontal,
      vertical: !horizontal,
      isDisabled: (index) => {
        const item = toolbarItems[index];
        return item === undefined || isDisabledToolbarItem(item);
      },
    });
    if (nextIndex === null || nextIndex === currentIndex) return;

    event.preventDefault();
    event.stopPropagation();
    moveFocus(
      nextIndex,
      event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'End' ? 'end' : 'start',
    );
  }

  function handleFocusIn(event: FocusEvent): void {
    onFocusIn?.(event);
    if (!isHTMLElement(event.target)) return;
    const target = event.target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!target || !isToolbarItemCandidate(target) || isDisabledToolbarItem(target)) return;
    sync(target);
  }

  return {
    sync,
    firstEnabledItem: () => toolbarItems.find((item) => !isDisabledToolbarItem(item)) ?? null,
    activeItem: () => activeItem,
    attach: () => {
      root.addEventListener('keydown', handleKeyDown, { capture: true });
      root.addEventListener('focusin', handleFocusIn);
      return () => {
        root.removeEventListener('keydown', handleKeyDown, { capture: true });
        root.removeEventListener('focusin', handleFocusIn);
        restoreDepartedItems([]);
      };
    },
  };
}
