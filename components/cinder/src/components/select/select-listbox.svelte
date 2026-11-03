<script lang="ts" generics="T extends string = string">
  /**
   * The drawn presentation of Select: a select-only combobox (a `button` with `role="combobox"`)
   * that opens a listbox in a Popover. Focus stays on the button for the whole interaction and
   * the listbox is driven with `aria-activedescendant`, as in the WAI-ARIA select-only combobox
   * pattern. `select.svelte` renders this inside its form-field frame when `presentation` is
   * `listbox`; it is not exported on its own.
   *
   * What the native `<select>` cannot draw is why this exists: a sentence and a note under each
   * option, group headings with messages, the check on the current option, a leading mark, and
   * a footer outside the listbox with its own keyboard stop.
   */
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  import { pushEscapeHandler } from '../../_internal/overlay.ts';
  import { PHONE_VIEWPORT_BREAKPOINT } from '../../_internal/viewport-below.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { getSequentialFocusTargets } from '../../utilities/focus.ts';
  import { commitValue } from '../../utilities/value-change.ts';
  import { createCommandListState } from '../_internal/create-command-list-state.svelte.ts';
  import Popover from '../popover/popover.svelte';
  import type { SelectGroup, SelectOption, SelectVariant } from './select.types.ts';

  type Section = {
    /** Group name, or `undefined` for the leading run of ungrouped options. */
    name: string | undefined;
    sectionIndex: number;
    heading: string | undefined;
    divided: boolean;
    message: Snippet | undefined;
    members: { option: SelectOption<T>; index: number }[];
  };

  let {
    id,
    value = $bindable(),
    options,
    groups = [],
    leading,
    footer,
    placeholder,
    valuePrefix,
    size = 'md',
    variant = 'default',
    disabled = false,
    readonly = false,
    required = false,
    name,
    form,
    describedBy,
    invalid,
    labelledBy,
    sheetBelow = PHONE_VIEWPORT_BREAKPOINT,
    class: className,
    onValueChange,
    onValueChangeRequest,
    ...rest
  }: {
    id: string;
    value?: T | undefined;
    options: readonly SelectOption<T>[];
    groups?: readonly SelectGroup[] | undefined;
    leading?: Snippet<[SelectOption<T>]> | undefined;
    footer?: Snippet | undefined;
    placeholder?: string | undefined;
    valuePrefix?: string | undefined;
    size?: 'sm' | 'md' | 'lg' | undefined;
    variant?: SelectVariant | undefined;
    disabled?: boolean | undefined;
    readonly?: boolean | undefined;
    required?: boolean | undefined;
    name?: string | undefined;
    form?: string | undefined;
    describedBy?: string | undefined;
    invalid?: 'true' | 'false' | 'grammar' | 'spelling' | undefined;
    /** Id of the element that names the control; names the listbox too. */
    labelledBy?: string | undefined;
    sheetBelow?: string | false | undefined;
    class?: string | undefined;
    onValueChange?: ((value: T) => void) | undefined;
    onValueChangeRequest?: ((next: T) => T | void) | undefined;
  } & Omit<
    HTMLButtonAttributes,
    | 'class'
    | 'id'
    | 'value'
    | 'name'
    | 'form'
    | 'disabled'
    | 'type'
    | 'role'
    | 'onclick'
    | 'onkeydown'
    | 'onkeyup'
    | 'children'
  > = $props();

  const listboxId = $derived(`${id}-listbox`);
  const optionId = (index: number): string => `${id}-option-${index}`;

  // Display order is the single source of truth: option ids, the active option, typeahead and
  // keyboard navigation all index into this flat list, and the sections below render it in the
  // same order. Ungrouped options come first, then each group in `groups` order (a group with
  // no options still shows its heading and message), then any group `groups` does not list.
  const sections = $derived.by<Section[]>(() => {
    const ungrouped: SelectOption<T>[] = [];
    const byName = new Map<string, SelectOption<T>[]>();
    for (const option of options) {
      const groupName = option.group?.trim();
      if (!groupName) {
        ungrouped.push(option);
        continue;
      }
      const members = byName.get(groupName);
      if (members) members.push(option);
      else byName.set(groupName, [option]);
    }
    const listed = new Set(groups.map((group) => group.name));
    const names = [
      ...groups.map((group) => group.name),
      ...[...byName.keys()].filter((key) => !listed.has(key)),
    ];

    const built: Section[] = [];
    let next = 0;
    const take = (list: readonly SelectOption<T>[]) =>
      list.map((option) => ({ option, index: next++ }));
    if (ungrouped.length > 0) {
      built.push({
        name: undefined,
        sectionIndex: built.length,
        heading: undefined,
        divided: false,
        message: undefined,
        members: take(ungrouped),
      });
    }
    for (const groupName of names) {
      const definition = groups.find((group) => group.name === groupName);
      built.push({
        name: groupName,
        sectionIndex: built.length,
        heading: definition?.heading ?? groupName,
        divided: definition?.divided ?? false,
        message: definition?.message,
        members: take(byName.get(groupName) ?? []),
      });
    }
    return built;
  });
  // What the listbox owns: the ungrouped options by id and each group's list. They are drawn
  // beside the (empty) listbox element so group messages stay outside it.
  const ownedIds = $derived(
    sections
      .flatMap((section) =>
        section.name === undefined
          ? section.members.map((member) => optionId(member.index))
          : section.members.length > 0
            ? [`${id}-group-options-${section.sectionIndex}`]
            : [],
      )
      .join(' ') || undefined,
  );
  const flat = $derived(sections.flatMap((section) => section.members.map((m) => m.option)));
  const selectedOption = $derived(
    value === undefined || value === '' ? undefined : options.find((o) => o.value === value),
  );

  let open = $state(false);
  let panelMounted = $state(false);
  let triggerElement = $state<HTMLButtonElement | null>(null);
  let contentElement = $state<HTMLElement | null>(null);
  let scrollElement = $state<HTMLElement | null>(null);

  // `navigateDisabled`: the cursor can stand on a disabled option so a keyboard user can read
  // its reason; choosing it stays refused (`commit`). `autoActivateFirst` is off because the
  // cursor starts on the current option when the list opens, and on the first one otherwise.
  const commandList = createCommandListState(() => listboxId, {
    autoActivateFirst: false,
    navigateDisabled: true,
  });

  const canOpen = $derived(
    !disabled && !readonly && (flat.length > 0 || footer !== undefined || sections.length > 0),
  );
  const activeIndex = $derived(
    commandList.activeItemId === null
      ? -1
      : flat.findIndex((_, index) => optionId(index) === commandList.activeItemId),
  );
  const activeDescendant = $derived(open && activeIndex >= 0 ? optionId(activeIndex) : undefined);

  $effect(() => {
    if (open) panelMounted = true;
  });

  // Register the rendered options with the shared command-list state, so the cursor can resolve
  // its id and scroll into view.
  $effect(() => {
    const scroller = scrollElement;
    if (!scroller || !open) return;
    const nodes = scroller.querySelectorAll<HTMLElement>('[role="option"]');
    commandList.syncItems(
      flat.flatMap((option, index) => {
        const node = nodes[index];
        return node
          ? [
              {
                id: optionId(index),
                node,
                getValue: () => option.value,
                getOnselect: () => () => commit(option),
                getDisabled: () => !!option.disabled,
              },
            ]
          : [];
      }),
    );
  });

  $effect(() => {
    if (!open) return;
    commandList.scrollActiveItemIntoView();
  });

  function setActive(index: number): void {
    if (index < 0) commandList.resetActiveItem();
    else commandList.setActiveById(optionId(index));
  }

  function firstEnabledIndex(): number {
    return flat.findIndex((option) => !option.disabled);
  }

  /** Opens the list with the cursor on the current option, or the first one that can be chosen. */
  function openList(): void {
    if (!canOpen) return;
    const current = selectedOption ? flat.indexOf(selectedOption) : -1;
    setActive(current >= 0 ? current : firstEnabledIndex());
    open = true;
  }

  function closeList(): void {
    open = false;
  }

  function commit(option: SelectOption<T>): void {
    if (option.disabled || readonly || disabled) return;
    const previous = value;
    // The request hook may refuse or replace the pick. `value` is written with whatever it
    // returns, even when that is the current value, so a one-way parent that refused the pick
    // still reads the old one back instead of keeping a local override of the choice.
    commitValue(
      option.value,
      onValueChangeRequest,
      (next) => {
        value = next;
      },
      (next) => {
        if (next !== previous) onValueChange?.(next);
      },
    );
    open = false;
    triggerElement?.focus();
  }

  // Escape closes the list and keeps focus where it was. Popover owns Escape for its panel; this
  // covers the cursor on the trigger, where Popover's handler is on the stack too.
  $effect(() => {
    if (!open) return;
    return pushEscapeHandler((event?: KeyboardEvent) => {
      open = false;
      event?.preventDefault();
    });
  });

  // When the list closes while focus is inside the panel (on a footer link, say), the panel is
  // about to unmount, so hand focus back to the trigger rather than dropping it on the page.
  $effect(() => {
    if (open) return;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (active && contentElement?.contains(active)) triggerElement?.focus();
  });

  /** The keyboard stops inside the panel that are not options: message links, footer controls. */
  function panelStops(): HTMLElement[] {
    return getSequentialFocusTargets(contentElement) as HTMLElement[];
  }

  let typeahead = '';
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
  function handleTypeahead(character: string): boolean {
    if (flat.length === 0) return false;
    clearTimeout(typeaheadTimer);
    typeahead += character.toLowerCase();
    typeaheadTimer = setTimeout(() => {
      typeahead = '';
    }, 700);
    const start =
      activeIndex >= 0 && typeahead.length === 1 ? activeIndex + 1 : Math.max(activeIndex, 0);
    for (let offset = 0; offset < flat.length; offset += 1) {
      const index = (start + offset) % flat.length;
      const option = flat[index];
      if (option && !option.disabled && option.label.toLowerCase().startsWith(typeahead)) {
        if (!open) openList();
        setActive(index);
        return true;
      }
    }
    return false;
  }

  $effect(() => () => clearTimeout(typeaheadTimer));

  function handleKeydown(event: KeyboardEvent): void {
    if (disabled || event.isComposing) return;
    const key = event.key;

    if (!open) {
      if (readonly) return;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        openList();
        return;
      }
      if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (handleTypeahead(key)) event.preventDefault();
      }
      return;
    }

    if (key === 'Tab') {
      const stops = panelStops();
      if (!event.shiftKey && stops.length > 0) {
        // The footer, and any link in a group message, is a stop of its own after the options:
        // the first Tab from the trigger lands on it.
        event.preventDefault();
        stops[0]?.focus();
        return;
      }
      closeList();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      if (key === ' ' && typeahead !== '') {
        handleTypeahead(' ');
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const option = activeIndex >= 0 ? flat[activeIndex] : undefined;
      if (option) commit(option);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      closeList();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      commandList.handleKeydown({ event });
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (handleTypeahead(key)) event.preventDefault();
    }
  }

  function handleKeyup(event: KeyboardEvent): void {
    // The native button activates on the keyup of Space; keydown already handled the key.
    if (event.key === ' ') event.preventDefault();
  }

  function handleClick(): void {
    if (open) closeList();
    else openList();
  }

  // Tab from the panel: the last stop hands focus back to the trigger and lets the browser
  // carry on to the next control; Shift+Tab from the first stop goes back to the trigger.
  function handlePanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const stops = panelStops();
    const index = stops.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.shiftKey && index === 0) {
      event.preventDefault();
      triggerElement?.focus();
    } else if (!event.shiftKey && index === stops.length - 1) {
      closeList();
      triggerElement?.focus();
    }
  }

  // A hidden input carries the value so the select takes part in a native form submission.
  let hiddenInput = $state<HTMLInputElement | null>(null);
  const initialValue = untrack(() => value);
  $effect(() => {
    const input = hiddenInput;
    const owner = input?.form;
    if (!owner) return;
    const reset = (event: Event): void => {
      setTimeout(() => {
        if (!event.defaultPrevented) value = initialValue;
      }, 0);
    };
    owner.addEventListener('reset', reset);
    return () => owner.removeEventListener('reset', reset);
  });

  /** Keeps the listbox open while focus moves between the trigger and the panel. */
  function handleTriggerBlur(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && contentElement?.contains(next)) return;
    if (open && next !== null) closeList();
  }

  const ariaLabel = $derived((rest as { 'aria-label'?: string })['aria-label']);
</script>

{#snippet optionRow(option: SelectOption<T>, index: number)}
  {@const selected = option.value === value}
  <!-- Keyboard selection happens on the trigger (aria-activedescendant), so the option itself takes only the pointer. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <li
    id={optionId(index)}
    role="option"
    class="cinder-_option-row cinder-select__option"
    aria-selected={selected}
    aria-disabled={option.disabled || undefined}
    data-cinder-active={index === activeIndex || undefined}
    onmousedown={(event) => {
      // Keep focus on the trigger: the listbox is driven by `aria-activedescendant`.
      event.preventDefault();
    }}
    onclick={() => commit(option)}
    onmouseenter={() => {
      if (!option.disabled) setActive(index);
    }}
  >
    {#if leading}
      <span class="cinder-select__option-leading" aria-hidden="true">{@render leading(option)}</span
      >
    {/if}
    <span class="cinder-select__option-text">
      <span class="cinder-select__option-label"
        >{option.label}{#if option.suffix}<span class="cinder-select__suffix"
            >{` · ${option.suffix}`}</span
          >{/if}</span
      >
      {#if option.description}
        <span class="cinder-select__option-description">{option.description}</span>
      {/if}
      {#if option.note}
        <span class="cinder-select__option-note">{option.note}</span>
      {/if}
    </span>
    {#if selected}
      <svg
        class="cinder-select__option-check"
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
    {/if}
  </li>
{/snippet}

<span class="cinder-select-field__control">
  <button
    bind:this={triggerElement}
    {...rest}
    {id}
    type="button"
    role="combobox"
    class={classNames('cinder-_input-frame', 'cinder-select', className)}
    data-cinder-size={size}
    data-cinder-variant={variant}
    data-cinder-presentation="listbox"
    data-cinder-open={open || undefined}
    data-cinder-empty={selectedOption === undefined && placeholder === undefined
      ? 'true'
      : undefined}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? listboxId : undefined}
    aria-activedescendant={activeDescendant}
    aria-readonly={readonly || undefined}
    aria-required={required || undefined}
    aria-invalid={invalid}
    aria-describedby={describedBy}
    aria-label={ariaLabel}
    onclick={handleClick}
    onkeydown={handleKeydown}
    onkeyup={handleKeyup}
    onblur={handleTriggerBlur}
  >
    {#if valuePrefix}
      <span class="cinder-select__prefix" aria-hidden="true">{valuePrefix}</span>
    {/if}
    {#if leading && selectedOption}
      <span class="cinder-select__leading" aria-hidden="true"
        >{@render leading(selectedOption)}</span
      >
    {/if}
    {#if selectedOption}
      <span class="cinder-select__value"
        >{selectedOption.label}{#if selectedOption.triggerSuffix}<span class="cinder-select__suffix"
            >{` · ${selectedOption.triggerSuffix}`}</span
          >{/if}</span
      >
    {:else if placeholder}
      <span class="cinder-select__value" data-cinder-placeholder>{placeholder}</span>
    {:else}
      <span class="cinder-select__value" aria-hidden="true">&nbsp;</span>
    {/if}
  </button>
  <span class="cinder-select-field__chevron" aria-hidden="true"></span>
</span>

{#if name}
  <input bind:this={hiddenInput} type="hidden" {name} {form} value={value ?? ''} {disabled} />
{/if}

{#if panelMounted}
  <Popover
    bind:open
    id="{id}-panel"
    triggerRef={triggerElement}
    role="group"
    {...ariaLabel ? { label: ariaLabel } : {}}
    focusManagement="preserve"
    wireTriggerAria={false}
    closeOnEscape={false}
    widthMode={variant === 'ghost' ? 'content' : 'match-anchor'}
    {sheetBelow}
    class="cinder-select__panel"
    onExitComplete={() => {
      panelMounted = false;
    }}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={contentElement}
      class="cinder-select__content"
      data-cinder-variant={variant}
      onkeydown={handlePanelKeydown}
    >
      <!-- The listbox owns its options by id (aria-owns) while they are drawn beside it, because
           a group's message is plain content with links and may not sit inside role="listbox". -->
      <div bind:this={scrollElement} class="cinder-select__scroll">
        <ul
          id={listboxId}
          role="listbox"
          class="cinder-select__listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : labelledBy}
          aria-multiselectable="false"
          aria-owns={ownedIds}
        ></ul>
        {#each sections as section (section.name ?? '')}
          {#if section.name === undefined}
            <ul role="presentation" class="cinder-select__options">
              {#each section.members as member (member.option.value)}
                {@render optionRow(member.option, member.index)}
              {/each}
            </ul>
          {:else}
            <div
              role="presentation"
              class="cinder-_option-group cinder-select__group"
              data-cinder-divided={section.divided || undefined}
            >
              <div role="presentation" class="cinder-_option-group__heading">
                <span id="{id}-group-{section.sectionIndex}" class="cinder-_option-group__label"
                  >{section.heading}</span
                >
              </div>
              {#if section.message}
                <div class="cinder-select__group-message">{@render section.message()}</div>
              {/if}
              {#if section.members.length > 0}
                <ul
                  id="{id}-group-options-{section.sectionIndex}"
                  role="group"
                  class="cinder-_option-group__options"
                  aria-labelledby="{id}-group-{section.sectionIndex}"
                >
                  {#each section.members as member (member.option.value)}
                    {@render optionRow(member.option, member.index)}
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
      {#if footer}
        <div class="cinder-select__footer">{@render footer()}</div>
      {/if}
    </div>
  </Popover>
{/if}
