<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Single-select input that filters a fixed option list as the user types, combining free-text search with constrained values.
   * @tag form
   * @tag autocomplete
   * @useWhen Choosing one value from a long list where typing is faster than scrolling.
   * @useWhen Letting users narrow options by substring while still requiring a constrained selection.
   * @avoidWhen Picking from a short fixed list with no need to filter — use select instead.
   * @avoidWhen Querying remote data or accepting free-text submissions — use search-field instead.
   * @related select, search-field, dropdown
   */
  export type {
    ComboboxFooterContext,
    ComboboxLoadError,
    ComboboxOption,
    ComboboxPresentation,
    ComboboxProps,
  } from './combobox.types.ts';
</script>

<script lang="ts" generics="T extends string = string, AllowCustom extends boolean = false">
  import type { ComboboxFooterContext, ComboboxOption, ComboboxProps } from './combobox.types.ts';
  import { tick, untrack } from 'svelte';

  import { composeDescribedBy, resolveFieldControl } from '../../_internal/field-control.ts';
  import { getFormFieldContext } from '../../_internal/form-field-context.ts';
  import FormFieldFrame from '../../_internal/form-field-frame.svelte';
  import { pushEscapeHandler } from '../../_internal/overlay.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { getSequentialFocusTargets } from '../../utilities/focus.ts';
  import { rowDividerAttachment } from '../../utilities/row-divider.ts';
  import { createCommandListState } from '../_internal/create-command-list-state.svelte.ts';
  import { groupOptions, hasGroupedOptions } from '../_internal/group-options.ts';
  import Button from '../button/button.svelte';
  import Popover from '../popover/popover.svelte';
  import ComboboxSearch from './combobox-search.svelte';
  import Skeleton from '../skeleton/skeleton.svelte';
  import { PHONE_VIEWPORT_BREAKPOINT } from '../../_internal/viewport-below.svelte.ts';

  let {
    id,
    value = $bindable(''),
    onValueChange,
    name,
    textInputValue = $bindable(''),
    options,
    label,
    'aria-label': ariaLabel,
    placeholder,
    filter,
    description,
    error,
    disabled,
    required,
    maxVisibleOptions = 200,
    customValueAllowed = false as AllowCustom,
    size = 'md',
    sheetBelow = PHONE_VIEWPORT_BREAKPOINT,
    presentation = 'input',
    searchPlaceholder = 'Search',
    loading = false,
    loadingLabel = 'Loading…',
    stillLoadingAfter,
    onCancel,
    loadError,
    onRetry,
    noMatchLabel = 'No results',
    footer,
    optionMeta,
    groupCountVisible = true,
    matchCountVisible = false,
    selectedIndicator = 'end',
    class: className,
    'aria-describedby': consumerDescribedBy,
  }: ComboboxProps<T, AllowCustom> = $props();

  const context = getFormFieldContext();
  const field = $derived(
    resolveFieldControl({
      id,
      generatedId: id,
      context,
      hasDescription: !!description,
      hasError: !!error,
      localIdNamespace: 'combobox',
      consumerDescribedBy,
      required,
      disabled,
    }),
  );
  const resolvedDisabled = $derived(field.disabled);
  const resolvedRequired = $derived(field.required);
  const describedBy = $derived(field.describedBy);

  const listboxId = $derived(`${id}-listbox`);
  // `autoActivateFirst: false` — an editable combobox shows no highlighted
  // option until the user types or explicitly navigates, unlike a
  // button-triggered listbox (MultiSelect, CommandMenu).
  // `navigateDisabled: true` — the arrow keys, Home and End stop on a disabled
  // row, so a keyboard user can scroll the whole list and read each disabled
  // row (COR-1981). Activation stays refused for it (`selectOption`).
  const commandList = createCommandListState(() => listboxId, {
    autoActivateFirst: false,
    navigateDisabled: true,
  });
  const descriptionId = $derived(field.ownDescriptionId);
  // Stable id for the always-in-DOM error live region when no error is active.
  // Mirrors Select: avoids colliding with a wrapping FormField's error id.
  const stableLocalErrorId = $derived(
    context?.errorId === `${field.id}-error` ? `${field.id}-combobox-error` : `${field.id}-error`,
  );

  const defaultFilter = (option: ComboboxOption<T>, query: string): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      option.label.toLowerCase().includes(q) ||
      (option.description?.toLowerCase().includes(q) ?? false)
    );
  };

  const groupOf = (option: ComboboxOption<T>): string | undefined => option.group;

  // Display order is the single source of truth: option ids, the active option
  // and keyboard navigation all index into this flat list, and the sections
  // below render it in the same order. With groups, the cap applies after the
  // ungrouped-first, group-by-group ordering so which options survive it is
  // predictable.
  const isPicker = $derived(presentation === 'picker');
  const panelLabel = $derived(label ?? (ariaLabel?.trim() || undefined));
  // A picker has no text of its own: what is typed in the panel's search field narrows the list
  // and nothing else, so the committed value's label is never disturbed by searching.
  let searchQuery = $state('');
  const query = $derived(isPicker ? searchQuery : textInputValue);
  // Committing arbitrary text needs a text field to type it into.
  const customValueCommittable = $derived(!!customValueAllowed && !isPicker);
  const interactive = $derived(!resolvedDisabled && !loading);

  const matchedOptions = $derived.by(() => {
    const fn = filter ?? defaultFilter;
    return options.filter((option) => fn(option, query));
  });
  const filteredOptions = $derived.by(() => {
    const grouped = hasGroupedOptions(options, groupOf);
    return grouped
      ? groupOptions(matchedOptions, groupOf).ordered.slice(0, maxVisibleOptions)
      : matchedOptions.slice(0, maxVisibleOptions);
  });
  const optionSections = $derived(groupOptions(filteredOptions, groupOf).sections);
  const selectedOption = $derived(
    value ? options.find((option) => option.value === value) : undefined,
  );
  const footerContext = $derived<ComboboxFooterContext>({
    query,
    matchCount: matchedOptions.length,
    totalCount: options.length,
  });
  // The message under the search field when nothing matches. It is not drawn when the list failed
  // to load and there is nothing to search: the load error already says why the list is empty.
  const noMatchText = $derived(
    typeof noMatchLabel === 'function' ? noMatchLabel(query) : noMatchLabel,
  );
  const emptyListed = $derived(
    filteredOptions.length === 0 && !(loadError && options.length === 0),
  );

  let open = $state(false);
  let inputElement = $state<HTMLInputElement | null>(null);
  let triggerElement = $state<HTMLButtonElement | null>(null);
  let contentElement = $state<HTMLElement | null>(null);
  let loadErrorElement = $state<HTMLElement | null>(null);
  let footerElement = $state<HTMLElement | null>(null);
  let hiddenInputElement = $state<HTMLInputElement | null>(null);
  let listboxElement = $state<HTMLElement | null>(null);
  let committedLabel = $state('');
  let initialCustomValue = $state('');
  let hasUserCommittedValue = $state(false);
  let hasExplicitNavigation = $state(false);
  let hasStoredInitialValue = $state(false);
  let resetSyncTimeout: ReturnType<typeof setTimeout> | undefined;
  let initialValue = $state(untrack(() => value));
  const initialInputValue = untrack(() => textInputValue);

  $effect.pre(() => {
    if (!hasUserCommittedValue && !hasStoredInitialValue && value) {
      initialValue = value;
      hasStoredInitialValue = true;
    }
    if (customValueAllowed && !hasUserCommittedValue && value && !initialCustomValue) {
      initialCustomValue = value;
    }
  });

  // When a value is provided externally, mirror its label in the input box.
  // The current input text is read untracked so typing can keep driving filtering.
  $effect(() => {
    if (!value) {
      // Clearing the value (deselect/reset) must also clear the visible text;
      // otherwise the input keeps showing the previously selected option's label.
      if (untrack(() => textInputValue)) textInputValue = '';
      committedLabel = '';
      return;
    }
    const matched = options.find((option) => option.value === value);
    if (matched) {
      // `committedLabel` tracks the committed `value`'s label and must stay in
      // sync whenever a match exists — even when `textInputValue` already shows that
      // label. Gating it behind the `textInputValue !== matched.label` check left
      // `committedLabel` stale (''), so a later Escape restored to empty text.
      committedLabel = matched.label;
      if (untrack(() => textInputValue) !== matched.label) {
        textInputValue = matched.label;
      }
    } else if (customValueAllowed) {
      if (!initialCustomValue) initialCustomValue = value;
      committedLabel = value;
      if (untrack(() => textInputValue) !== value) textInputValue = value;
    }
  });

  // Escape ownership.
  //
  // The combobox is the single Escape owner for the whole time it is open. The
  // option Popover is told `closeOnEscape={false}`, so it never registers its
  // own escape-stack handler — otherwise, while options are visible, the
  // Popover's handler would sit on top of the shared LIFO stack and shadow this
  // one. With the Popover opting out, this combobox's handler is the top-most
  // Escape consumer for the entire open session, including the empty-filter gap
  // (`open && filteredOptions.length === 0`) where the Popover is unmounted.
  //
  // That matters most when the combobox is nested inside a Modal/Drawer: the
  // shared escape stack's window listener is capture-phase and invokes ONLY its
  // top handler, so this combobox consumes Escape and `preventDefault()`s it
  // before the parent overlay ever sees the key — Escape dismisses just the
  // combobox, never the enclosing overlay.
  function handleEscape(event: KeyboardEvent | undefined = undefined): void {
    const wasOpen = open;
    open = false;
    // Restore the committed label whenever the live text drifted from it. A picker never edits
    // that text, so there is nothing to restore.
    if (!isPicker && textInputValue !== committedLabel) {
      textInputValue = committedLabel;
      if (inputElement) inputElement.value = committedLabel;
    }
    // Swallow the key if the combobox actually consumed this Escape (it was
    // open) so the same keystroke doesn't also dismiss an enclosing overlay or
    // trigger a page-level default.
    if (wasOpen) event?.preventDefault();
  }

  $effect(() => {
    if (!open) return;
    const releaseEscape = pushEscapeHandler(handleEscape);
    return releaseEscape;
  });

  // The panel is shown whenever the field is open and can be used: even with no options it holds
  // the search field (picker), the empty message, the load error and the footer.
  const panelVisible = $derived(open && interactive);
  const listboxVisible = $derived(panelVisible && filteredOptions.length > 0);
  const emptyVisible = $derived(panelVisible && emptyListed);
  // COR-499: the status paragraph that names the empty result set — rendered
  // outside the listbox (see comboboxControl below), never as a fake
  // role="option" child, matching CommandMenu's empty-state pattern
  // (command-menu.svelte's `emptyStateId`/`showEmptyState`). Composed into the
  // input's own aria-describedby, since Popover's role="listbox" panel has no
  // aria-describedby prop to carry the same association CommandMenu puts
  // directly on its <ul role="listbox">.
  const emptyStatusId = $derived(`${id}-empty-status`);

  /**
   * Whether the composed Popover instance should stay MOUNTED (CIN-376
   * round 20 review). `panelVisible` is derived directly from `open`, so the
   * instant `open` flips false it goes false in the SAME update — an `{#if
   * panelVisible}` around the Popover would destroy the whole composed
   * instance immediately, before Popover's OWN retained-exit lifecycle (which
   * keeps its panel mounted through `data-cinder-closing`, not an `{#if}` gate
   * around its own root) ever gets a chance to run — the listbox would still
   * snap closed instead of fading. `panelMounted` mirrors it becoming true,
   * but only clears via Popover's `onExitComplete` once its exit genuinely
   * finishes. What the panel draws (options or the empty message) depends on
   * the filtered list, not on `open`, so it keeps rendering the same content
   * through its own exit rather than switching mid-fade.
   */
  let panelMounted = $state(false);
  $effect(() => {
    if (panelVisible) panelMounted = true;
  });
  // The field cannot stay open once it is disabled or loading.
  $effect(() => {
    if (!interactive) open = false;
  });
  const activeOptionId = $derived(
    listboxVisible ? (commandList.activeItemId ?? undefined) : undefined,
  );
  const activeIndex = $derived(
    commandList.activeItemId === null
      ? -1
      : filteredOptions.findIndex(
          (_, index) => `${id}-option-${index}` === commandList.activeItemId,
        ),
  );

  /**
   * First non-disabled index in `filteredOptions`, or -1 if none. Typing starts
   * the cursor here: a disabled row is reachable with the arrow keys but is
   * never where a fresh filter lands.
   */
  function firstEnabledFilteredIndex(): number {
    return filteredOptions.findIndex((option) => !option.disabled);
  }

  /**
   * Sets the active option by its position in `filteredOptions`, translating
   * to the shared `commandList`'s id-based `activeItemId`. `commandList`
   * registers option ids asynchronously (see the `syncItems` effect below) —
   * this can run before that registration completes, since the roving index
   * itself is computed directly from `filteredOptions` rather than from
   * `commandList.navigableIds`. `activeItemId` is `$derived`, so once
   * registration catches up it re-resolves to the id set here; no explicit
   * ordering between the two is required.
   *
   * A disabled option can be active (`navigateDisabled`), so the cursor can
   * stand on it and `aria-activedescendant` can name it; `selectOption` is what
   * refuses to choose it.
   */
  function setActiveIndex(index: number): void {
    if (index < 0) commandList.resetActiveItem();
    else commandList.setActiveById(`${id}-option-${index}`);
  }

  /**
   * Moves the active option to the next/previous option, disabled ones
   * included, wrapping around. Skipping them would leave a keyboard user unable
   * to scroll to, or read, a disabled row.
   */
  function moveActive(direction: 1 | -1): void {
    const count = filteredOptions.length;
    if (count === 0) return;
    if (activeIndex < 0) {
      setActiveIndex(direction === 1 ? 0 : count - 1);
      return;
    }
    setActiveIndex((activeIndex + direction + count) % count);
  }

  /** Moves the active option to the first/last option, disabled or not. */
  function moveToBoundary(direction: 'start' | 'end'): void {
    setActiveIndex(
      filteredOptions.length === 0 ? -1 : direction === 'start' ? 0 : filteredOptions.length - 1,
    );
  }

  /** Live option-list registration so `commandList` can resolve `activeItemId` and scroll the active option into view. */
  $effect(() => {
    const listbox = listboxElement;
    if (!listbox || !listboxVisible) return;
    const optionNodes = listbox.querySelectorAll<HTMLElement>('[role="option"]');
    commandList.syncItems(
      filteredOptions.flatMap((option, index) => {
        const node = optionNodes[index];
        return node
          ? [
              {
                id: `${id}-option-${index}`,
                node,
                getValue: () => option.value,
                getOnselect: () => () => selectOption(option),
                getDisabled: () => !!option.disabled,
              },
            ]
          : [];
      }),
    );
  });

  $effect(() => {
    if (!listboxVisible) return;
    commandList.scrollActiveItemIntoView();
  });

  function findCommittedOption(rawValue: string): ComboboxOption<T> | undefined {
    const typed = rawValue.trim();
    if (!typed) return undefined;
    let labelMatch: ComboboxOption<T> | undefined;
    for (const option of options) {
      if (option.disabled) continue;
      if (option.value === typed) return option;
      // Keep scanning after the first label match so an exact value match later
      // in the list still wins over a human-readable label collision.
      if (labelMatch === undefined && option.label === typed) {
        labelMatch = option;
      }
    }
    return labelMatch;
  }

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    if (isPicker) searchQuery = target.value;
    else textInputValue = target.value;
    if (!interactive) return;
    open = true;
    setActiveIndex(firstEnabledFilteredIndex());
    hasExplicitNavigation = false;
  }

  /** The search field's value changed (picker): the same narrowing as typing into the input. */
  function handleSearchChange(nextQuery: string): void {
    searchQuery = nextQuery;
    setActiveIndex(firstEnabledFilteredIndex());
    hasExplicitNavigation = false;
  }

  function handleFocus() {
    if (interactive) open = true;
  }

  /** Opens a picker's panel with the search cleared and the cursor on the chosen option. */
  function openPicker(): void {
    if (!interactive) return;
    searchQuery = '';
    hasExplicitNavigation = false;
    open = true;
    const chosen = value ? options.findIndex((option) => option.value === value) : -1;
    setActiveIndex(chosen);
  }

  function handleBlur(event: FocusEvent) {
    // Defer close so a click on a listbox option can complete first. Use a DOM
    // containment check rather than a `#${listboxId}` selector so ids with
    // CSS-special characters (colons, dots, leading digits) don't throw. Anything in the
    // panel counts as inside, so a footer link or the retry button keeps the list open, and so
    // does the picker's own trigger, whose click closes the list itself.
    const next = event.relatedTarget as Node | null;
    if (next && contentElement?.contains(next)) return;
    if (next && isPicker && next === triggerElement) return;
    if (customValueCommittable && textInputValue.trim() && textInputValue !== committedLabel) {
      commitCustomValue();
      return;
    }
    open = false;
    if (isPicker) return;
    // Restore the committed label if the live text drifted from it. Leaving the
    // field on a stale edit (without selecting an option) would desync the
    // visible text from the unchanged `value` — the same mismatch Escape fixes.
    if (textInputValue !== committedLabel) {
      textInputValue = committedLabel;
      if (inputElement) inputElement.value = committedLabel;
    }
  }

  function selectOption(option: ComboboxOption<T>) {
    if (option.disabled) return;
    hasUserCommittedValue = true;
    value = option.value;
    textInputValue = option.label;
    committedLabel = option.label;
    open = false;
    onValueChange?.(option.value);
  }

  function commitCustomValue(): void {
    const nextValue = textInputValue.trim();
    if (!customValueCommittable || !nextValue) return;
    if (
      options.some(
        (option) => option.disabled && (option.value === nextValue || option.label === nextValue),
      )
    ) {
      textInputValue = committedLabel;
      if (inputElement) inputElement.value = committedLabel;
      open = false;
      return;
    }
    hasUserCommittedValue = true;
    const matched = findCommittedOption(nextValue);
    const committedValue = matched?.value ?? nextValue;
    const committedText = matched?.label ?? nextValue;
    const previousValue = value;
    // This path only runs when arbitrary values are explicitly allowed.
    value = committedValue as T;
    textInputValue = committedText;
    committedLabel = committedText;
    open = false;
    if (committedValue !== previousValue) onValueChange?.(committedValue as T);
  }

  function resetToInitialValue(event: Event): void {
    if (resetSyncTimeout !== undefined) clearTimeout(resetSyncTimeout);
    resetSyncTimeout = setTimeout(() => {
      resetSyncTimeout = undefined;
      if (event.defaultPrevented) return;
      // Use captured initialValue directly; don't fall back to defaultValue
      // because Svelte's reactive binding updates the attribute (and thus defaultValue).
      const resetValue = hasStoredInitialValue
        ? initialValue
        : customValueAllowed
          ? initialCustomValue || committedLabel
          : '';
      value = resetValue as T;
      const matched = options.find((option) => option.value === resetValue);
      const nextInputValue =
        matched?.label ?? (customValueAllowed ? resetValue : initialInputValue);
      textInputValue = nextInputValue;
      committedLabel = matched?.label ?? (customValueAllowed ? resetValue : '');
      open = false;
      commandList.resetActiveItem();
      if (inputElement) inputElement.value = nextInputValue;
      if (hiddenInputElement) hiddenInputElement.value = resetValue;
    }, 0);
  }

  $effect(() => {
    const input = hiddenInputElement;
    if (input === null) return;
    const form = input.form;
    form?.addEventListener('reset', resetToInitialValue);
    return () => {
      form?.removeEventListener('reset', resetToInitialValue);
      if (resetSyncTimeout !== undefined) {
        clearTimeout(resetSyncTimeout);
        resetSyncTimeout = undefined;
      }
    };
  });

  $effect(() => {
    inputElement?.setCustomValidity(
      (resolvedRequired && !value) || (!customValueAllowed && textInputValue !== committedLabel)
        ? 'Please select an option.'
        : '',
    );
  });

  /**
   * The keyboard stops inside the panel that are not options: the retry button and any link or
   * button in the footer. Options are never tab stops, so the search field and the clear button
   * inside it are deliberately not counted.
   */
  function panelStops(): HTMLElement[] {
    return [
      ...getSequentialFocusTargets(loadErrorElement),
      ...getSequentialFocusTargets(footerElement),
    ] as HTMLElement[];
  }

  /** The element that holds focus while the list is open: the input, or the picker's search field. */
  function focusOwner(): HTMLElement | null {
    if (!isPicker) return inputElement;
    return contentElement?.querySelector<HTMLInputElement>('input') ?? null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!interactive || event.isComposing) return;
    if (event.key === 'Tab') {
      if (!open) return;
      const stops = panelStops();
      if (!event.shiftKey && stops.length > 0) {
        // The retry button and the footer are stops of their own after the options: the first
        // Tab from the field lands on them.
        event.preventDefault();
        stops[0]?.focus();
      } else if (isPicker) {
        // Focus moves back to the trigger first so the browser carries on from there.
        open = false;
        triggerElement?.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open = true;
      if (filteredOptions.length === 0) return;
      moveActive(1);
      hasExplicitNavigation = true;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open = true;
      if (filteredOptions.length === 0) return;
      moveActive(-1);
      hasExplicitNavigation = true;
    } else if (event.key === 'Home') {
      if (!open) return;
      event.preventDefault();
      moveToBoundary('start');
      hasExplicitNavigation = true;
    } else if (event.key === 'End') {
      if (!open) return;
      event.preventDefault();
      moveToBoundary('end');
      hasExplicitNavigation = true;
    } else if (event.key === 'Enter' && open) {
      const option = filteredOptions[activeIndex];
      if (customValueCommittable && !(hasExplicitNavigation && option)) {
        event.preventDefault();
        commitCustomValue();
      } else if (option) {
        event.preventDefault();
        selectOption(option);
      }
    } else if (event.key === 'Escape') {
      // Fallback path. In a real browser the capture-phase escape-stack listener
      // (installed by the $effect's pushEscapeHandler) runs first and has
      // already closed + restored + preventDefault'd; `defaultPrevented` is true
      // here and we bail. This branch only does real work when the stack
      // listener never ran — SSR/no-window environments where `window` is
      // absent so `pushEscapeHandler` installed nothing.
      if (event.defaultPrevented) return;
      handleEscape(event);
    }
  }

  /** Keys on the picker's closed trigger: the ones that open a select-only combobox. */
  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (!interactive || event.isComposing) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!open) openPicker();
    }
  }

  function handleTriggerClick(): void {
    if (open) open = false;
    else openPicker();
  }

  function handleTriggerMousedown(event: MouseEvent): void {
    // While open, focus is in the search field: keep it there so the click that follows can
    // close the list instead of the blur doing it and the click opening it again.
    if (open) event.preventDefault();
  }

  // Focus follows the open state: into the picker's search field when its panel opens, and back
  // onto the field that owns it when the list closes while focus was inside the panel (the search
  // field or a footer link is about to unmount).
  $effect(() => {
    if (!panelVisible || !isPicker) return;
    const content = contentElement;
    if (!content) return;
    const panel = content.closest<HTMLElement>('.cinder-popover');
    let observer: MutationObserver | undefined;
    let cancelled = false;
    // The panel is hidden until it has been positioned, and a hidden control cannot take focus,
    // so focus lands as soon as Popover marks the panel ready.
    const focusSearch = (): boolean => {
      if (cancelled) return true;
      if (panel?.getAttribute('data-cinder-position-ready') === 'false') return false;
      const search = content.querySelector<HTMLInputElement>('input');
      if (!search) return false;
      if (document.activeElement !== search) search.focus();
      return document.activeElement === search;
    };
    void (async () => {
      // The search input mounts after the panel does.
      await tick();
      if (focusSearch() || !panel) return;
      observer = new MutationObserver(() => {
        if (focusSearch()) observer?.disconnect();
      });
      observer.observe(panel, {
        attributes: true,
        attributeFilter: ['data-cinder-position-ready'],
      });
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  });
  $effect(() => {
    if (open) return;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (active && contentElement?.contains(active)) {
      (isPicker ? triggerElement : inputElement)?.focus();
    }
  });

  // Tab from the panel: the last stop hands focus back to the field and lets the browser carry
  // on to the next control; Shift+Tab from the first stop goes back to the search field.
  function handlePanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const stops = panelStops();
    const index = stops.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.shiftKey && index === 0) {
      event.preventDefault();
      focusOwner()?.focus();
    } else if (!event.shiftKey && index === stops.length - 1) {
      open = false;
      (isPicker ? triggerElement : inputElement)?.focus();
    }
  }

  // A press on the panel's text or padding must not pull focus off the field (the panel root is
  // focusable, so the browser would move it there and the list would close on the blur). Controls
  // inside it, the retry button and footer links, still take focus.
  function handlePanelMousedown(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('input, button, a, select, textarea')) return;
    event.preventDefault();
  }

  /** Accessible name of an option: its text lines joined, so a reader hears the reason a row is off. */
  function optionName(option: ComboboxOption<T>): string | undefined {
    const parts = [option.label, option.code, option.description, option.meta].filter(Boolean);
    return parts.length > 1 ? parts.join(', ') : undefined;
  }
</script>

{#snippet checkMark(visible: boolean)}
  <svg
    class="cinder-combobox__option-check"
    data-cinder-visible={visible || undefined}
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
  >
{/snippet}

{#snippet optionRow(option: ComboboxOption<T>, index: number)}
  <li
    {@attach rowDividerAttachment}
    id="{id}-option-{index}"
    role="option"
    class="cinder-_option-row cinder-combobox__option"
    aria-selected={value === option.value}
    aria-disabled={option.disabled || undefined}
    aria-label={optionName(option)}
    data-cinder-active={index === activeIndex || undefined}
    onmousedown={(event) => {
      // mousedown rather than click so the option fires before the
      // input's blur cancels the popover.
      event.preventDefault();
      selectOption(option);
    }}
    onmouseenter={() => {
      // Hovering a disabled option leaves the active option alone: the
      // pointer can rest on a disabled row without moving the keyboard cursor
      // off the option the user navigated to.
      if (option.disabled) return;
      setActiveIndex(index);
    }}
  >
    {#if selectedIndicator === 'start'}
      {@render checkMark(value === option.value)}
    {/if}
    {#if option.avatar?.trim()}
      <img class="cinder-combobox__option-avatar" src={option.avatar} alt="" loading="lazy" />
    {/if}
    <span class="cinder-combobox__option-text">
      <span class="cinder-combobox__option-heading">
        <span class="cinder-combobox__option-label">{option.label}</span>
        {#if option.code}
          <code class="cinder-combobox__option-code">{option.code}</code>
        {/if}
      </span>
      {#if option.description}
        <span
          class="cinder-combobox__option-description"
          data-cinder-tone={option.descriptionTone === 'danger' ? 'danger' : undefined}
          >{option.description}</span
        >
      {/if}
    </span>
    {#if optionMeta}
      <span class="cinder-combobox__option-meta">{@render optionMeta(option)}</span>
    {:else if option.meta}
      <span class="cinder-combobox__option-meta">{option.meta}</span>
    {/if}
    {#if selectedIndicator === 'end' && value === option.value}
      {@render checkMark(true)}
    {/if}
  </li>
{/snippet}

{#snippet optionList()}
  <ul
    bind:this={listboxElement}
    id={listboxId}
    role="listbox"
    class="cinder-combobox__listbox"
    aria-label={label ?? (ariaLabel?.trim() || undefined)}
    hidden={filteredOptions.length === 0 || undefined}
  >
    {#each optionSections as section (section.group ?? '')}
      {#if section.group === undefined}
        {#each section.members as member (member.option.value)}
          {@render optionRow(member.option, member.index)}
        {/each}
      {:else}
        <li role="presentation" class="cinder-_option-group">
          <div role="presentation" class="cinder-_option-group__heading">
            <span id="{id}-group-{section.sectionIndex}" class="cinder-_option-group__label"
              >{section.group}</span
            >
            {#if groupCountVisible}
              <span class="cinder-_option-group__count" aria-hidden="true"
                >{section.members.length}</span
              >
            {/if}
          </div>
          <ul
            role="group"
            class="cinder-_option-group__options"
            aria-labelledby="{id}-group-{section.sectionIndex}"
          >
            {#each section.members as member (member.option.value)}
              {@render optionRow(member.option, member.index)}
            {/each}
          </ul>
        </li>
      {/if}
    {/each}
  </ul>
{/snippet}

{#snippet panelBody()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={contentElement}
    class="cinder-combobox__content"
    data-cinder-presentation={presentation}
    onkeydown={handlePanelKeydown}
    onmousedown={handlePanelMousedown}
  >
    {#if isPicker}
      <div class="cinder-combobox__search">
        <ComboboxSearch
          id="{id}-search"
          class="cinder-combobox__search-field"
          value={searchQuery}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          aria-expanded={true}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          onValueChange={handleSearchChange}
          onkeydown={handleKeydown}
          onblur={handleBlur}
        />
        {#if matchCountVisible && searchQuery}
          <span class="cinder-combobox__match-count" role="status"
            >{matchedOptions.length} of {options.length}</span
          >
        {/if}
      </div>
    {/if}
    {#if loadError}
      <div bind:this={loadErrorElement} class="cinder-combobox__load-error" role="alert">
        <div class="cinder-combobox__load-error-text">
          <span class="cinder-combobox__load-error-title">{loadError.title}</span>
          {#if loadError.description}
            <span class="cinder-combobox__load-error-description">{loadError.description}</span>
          {/if}
        </div>
        {#if onRetry}
          <Button
            variant="secondary"
            size="sm"
            label={loadError.retryLabel ?? 'Try again'}
            onclick={() => onRetry()}
          />
        {/if}
      </div>
    {/if}
    {@render optionList()}
    {#if emptyListed}
      <!--
        COR-499: plain, non-interactive visible copy — no role="option" (this
        is not a selectable/fake option), no aria-disabled, no aria-selected.
        Zero role="option" elements exist anywhere while the result set is
        empty; the associated status description lives outside the panel, in
        `.cinder-combobox__empty-status` below.
      -->
      <div class="cinder-combobox__empty" data-cinder-active>{noMatchText}</div>
    {/if}
    {#if footer}
      <div bind:this={footerElement} class="cinder-combobox__footer">
        {@render footer(footerContext)}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet comboboxControl()}
  <div class="cinder-combobox__control" data-cinder-open={open || undefined}>
    {#if isPicker}
      <button
        bind:this={triggerElement}
        {id}
        type="button"
        role="combobox"
        class="cinder-combobox__input cinder-combobox__trigger"
        data-cinder-size={size}
        data-cinder-open={open || undefined}
        disabled={resolvedDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel?.trim() || undefined}
        aria-invalid={field.ariaInvalid}
        aria-required={resolvedRequired || undefined}
        aria-busy={loading || undefined}
        aria-describedby={describedBy}
        onclick={handleTriggerClick}
        onmousedown={handleTriggerMousedown}
        onkeydown={handleTriggerKeydown}
      >
        {#if loading}
          <span class="cinder-combobox__trigger-value" data-cinder-placeholder>{loadingLabel}</span>
        {:else if selectedOption}
          <span class="cinder-combobox__trigger-heading">
            <span class="cinder-combobox__trigger-value">{selectedOption.label}</span>
            {#if selectedOption.code}
              <code class="cinder-combobox__option-code">{selectedOption.code}</code>
            {/if}
          </span>
          {#if selectedOption.description}
            <span class="cinder-combobox__trigger-description">{selectedOption.description}</span>
          {/if}
        {:else}
          <span class="cinder-combobox__trigger-value" data-cinder-placeholder
            >{placeholder ?? ''}</span
          >
        {/if}
      </button>
    {:else}
      <input
        bind:this={inputElement}
        {id}
        type="text"
        role="combobox"
        class="cinder-combobox__input"
        data-cinder-size={size}
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        disabled={resolvedDisabled}
        readonly={loading || undefined}
        required={resolvedRequired}
        placeholder={loading ? loadingLabel : placeholder}
        value={textInputValue}
        aria-autocomplete="list"
        aria-label={ariaLabel?.trim() || undefined}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-invalid={field.ariaInvalid}
        aria-required={resolvedRequired || undefined}
        aria-busy={loading || undefined}
        aria-describedby={composeDescribedBy(describedBy, emptyVisible ? emptyStatusId : undefined)}
        oninput={handleInput}
        onfocus={handleFocus}
        onblur={handleBlur}
        onkeydown={handleKeydown}
      />
    {/if}
    <span class="cinder-combobox__chevron" aria-hidden="true"></span>
  </div>

  {#if loading && stillLoadingAfter !== undefined}
    <!-- Skeleton's own status line, drawn alone: the field above is the placeholder. -->
    <div class="cinder-combobox__still-loading">
      <Skeleton {stillLoadingAfter} {...onCancel ? { onCancel } : {}} />
    </div>
  {/if}

  {#if name}
    <input
      bind:this={hiddenInputElement}
      type="hidden"
      {name}
      {value}
      disabled={resolvedDisabled}
    />
  {/if}

  {#if panelMounted}
    <Popover
      bind:open
      id="{id}-panel"
      triggerRef={isPicker ? triggerElement : inputElement}
      role="group"
      {...panelLabel ? { label: panelLabel } : {}}
      focusManagement="preserve"
      wireTriggerAria={false}
      closeOnEscape={false}
      widthMode="match-anchor"
      {sheetBelow}
      portalScopeClass={classNames('cinder-combobox', className)}
      class="cinder-combobox__panel"
      onExitComplete={() => {
        panelMounted = false;
      }}
    >
      {@render panelBody()}
    </Popover>
  {/if}

  <!-- The one status description for the empty result set, kept outside the
       panel and referenced from the input's aria-describedby — the same
       describedby-based association CommandMenu uses from its `role="listbox"`
       element (command-menu.svelte's `emptyStateId`). Always mounted, like
       FormFieldFrame's error region, so aria-live is registered before text is
       injected. -->
  <div id={emptyStatusId} class="cinder-combobox__empty-status" role="status">
    {emptyVisible ? noMatchText : ''}
  </div>
{/snippet}

<!-- FormFieldFrame keeps the error node mounted by default so the live region
     is registered before text is injected; freshly-mounted aria-live nodes
     are not reliably announced by NVDA/JAWS. -->
<FormFieldFrame
  {id}
  {label}
  {description}
  {error}
  required={resolvedRequired}
  disabled={resolvedDisabled}
  class={classNames('cinder-combobox', className)}
  labelClass="cinder-combobox__label"
  descriptionClass="cinder-combobox__description"
  errorClass="cinder-combobox__error"
  {descriptionId}
  errorId={field.ownErrorId ?? stableLocalErrorId}
  control={comboboxControl}
/>
