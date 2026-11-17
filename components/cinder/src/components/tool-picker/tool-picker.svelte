<script lang="ts" module>
  /**
   * @cinder
   * @category overlay
   * @status beta
   * @purpose Dialog for choosing tools and skills from a searchable list grouped by source, with each tool's risk and starting level, a counter, a loading state and collapsing groups for long lists.
   * @tag overlay
   * @tag dialog
   * @tag selection
   * @tag search
   * @useWhen Letting a person choose several items that carry a name, an identifier, a description and trailing facts, from grouped sources.
   * @useWhen The list can be long enough to need search and collapsing groups, and some entries are shown but cannot be chosen.
   * @avoidWhen Choosing one item from a short list — use select or combobox instead.
   * @avoidWhen Moving items between two lists the person keeps open — use transfer-list instead.
   * @rationale Nearest alternative: Modal with a Checkbox group — this adds the grouped, sticky-headed list, the search, the counter and the loading and empty states a long catalogue needs.
   * @related modal, checkbox, transfer-list, combobox, skeleton
   */
  export type { ToolPickerGroup, ToolPickerItem, ToolPickerProps } from './tool-picker.types.ts';
</script>

<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { untrack } from 'svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import { ChevronDown, ChevronRight } from '../icons/index.ts';
  import Input from '../input/input.svelte';
  import Modal from '../modal/modal.svelte';
  import Skeleton from '../skeleton/skeleton.svelte';
  import type { ToolPickerItem, ToolPickerProps } from './tool-picker.types.ts';
  import {
    buildSections,
    chosenCount,
    isSelectable,
    matchesQuery,
    orderChosen,
  } from './tool-picker.utilities.ts';

  let {
    open = $bindable(false),
    selected = $bindable<string[]>([]),
    query = $bindable(''),
    items,
    groups,
    title = 'Add tools and skills',
    itemNoun = 'tools',
    searchLabel = 'Search tools and skills',
    collapseFrom = 40,
    loading = false,
    loadingLabel = 'Loading tools and skills',
    noneChosenLabel = 'none chosen',
    emptyMetaLabel = 'No risk word',
    emptyLabel = `No ${itemNoun} to choose from.`,
    noMatchTitle = (typed: string) => `No ${itemNoun} match “${typed}”`,
    noMatchHint = 'Try a shorter word.',
    clearSearchLabel = 'Clear search',
    doneLabel = 'Done',
    cancelLabel = 'Cancel',
    onDone,
    onCancel,
    triggerRef = null,
    class: className,
  }: ToolPickerProps = $props();

  const baseId = $props.id();
  const searchId = `${baseId}-search`;

  // The picker edits a copy, so Cancel leaves what the page holds untouched.
  let chosen = $state<ReadonlySet<string>>(new Set());
  // A group the person opened or closed by hand; a group not listed here follows the default
  // (the first one open, the rest closed) in the long-list layout.
  const toggled = new SvelteMap<string, boolean>();

  let previousOpen = untrack(() => open);
  if (untrack(() => open)) chosen = new Set(untrack(() => selected));

  $effect(() => {
    if (open === previousOpen) return;
    previousOpen = open;
    // A search belongs to one visit: it is cleared as the picker closes, so it opens empty unless
    // the page sets `query` before opening it.
    if (!open) {
      query = '';
      return;
    }
    chosen = new Set(untrack(() => selected));
    toggled.clear();
  });

  const sections = $derived(buildSections(items, groups));
  const selectableTotal = $derived(items.filter(isSelectable).length);
  const longList = $derived(selectableTotal >= collapseFrom);
  const searching = $derived(query.trim() !== '');
  const itemIndex = $derived(new Map(items.map((item, index) => [item.value, index])));
  const showMeta = $derived(items.some((item) => item.meta !== undefined));
  const showDetail = $derived(items.some((item) => item.detail !== undefined));

  // What the list shows: every group with an item that answers the search.
  const visibleSections = $derived(
    sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => matchesQuery(item, query)),
        total: section.items.length,
      }))
      .filter((section) => section.items.length > 0),
  );
  const empty = $derived(!loading && searching && visibleSections.length === 0);

  const chosenTotal = $derived(
    items.filter((item) => isSelectable(item) && chosen.has(item.value)).length,
  );
  const counter = $derived(
    longList
      ? chosenTotal > 0
        ? `${selectableTotal} ${itemNoun}, ${chosenTotal} chosen`
        : `${selectableTotal} ${itemNoun}`
      : `${chosenTotal} of ${selectableTotal} ${itemNoun} chosen`,
  );
  const emptyTitle = $derived(
    typeof noMatchTitle === 'function' ? noMatchTitle(query.trim()) : noMatchTitle,
  );

  function expanded(name: string, position: number): boolean {
    if (!longList || searching) return true;
    return toggled.get(name) ?? position === 0;
  }

  function toggleGroup(name: string, position: number): void {
    toggled.set(name, !expanded(name, position));
  }

  function setChosen(item: ToolPickerItem, checked: boolean): void {
    const next = new Set(chosen);
    if (checked) next.add(item.value);
    else next.delete(item.value);
    chosen = next;
  }

  function groupSummary(section: (typeof visibleSections)[number]): string {
    const count = searching ? section.items.length : section.total;
    if (longList) return `${count} ${itemNoun}`;
    const parts = [`${count}`];
    const selectable = section.items.some(isSelectable);
    if (!selectable && section.note) parts.push(section.note);
    else if (selectable && chosenTotal > 0 && chosenCount(section, chosen) === 0) {
      parts.push(noneChosenLabel);
    }
    return parts.join(', ');
  }

  function handleDone(): void {
    const next = orderChosen(items, chosen, selected);
    selected = next;
    open = false;
    onDone?.(next);
  }

  function handleCancel(): void {
    open = false;
    onCancel?.();
  }

  function clearSearch(): void {
    query = '';
    document.getElementById(searchId)?.focus();
  }
</script>

<Modal
  bind:open
  {title}
  {triggerRef}
  closeButtonVisible={false}
  class={classNames('cinder-tool-picker', className)}
  onDismiss={() => onCancel?.()}
>
  {#snippet headerTrailing()}
    <!-- While the catalogue loads there is nothing to count: "0 of 0 tools chosen" would be read
         out as a fact, so the counter appears with the list. -->
    {#if !loading}
      <span class="cinder-tool-picker__counter" aria-live="polite">{counter}</span>
    {/if}
  {/snippet}

  <div class="cinder-tool-picker__search">
    <Input
      id={searchId}
      type="search"
      label={searchLabel}
      labelVisible={false}
      placeholder={searchLabel}
      autocomplete="off"
      bind:value={query}
    />
  </div>

  <div class="cinder-tool-picker__list" data-cinder-long={longList ? '' : undefined}>
    {#if loading}
      <div class="cinder-tool-picker__loading">
        <Skeleton lines={3} delay={300} label={loadingLabel} />
      </div>
    {:else if items.length === 0}
      <p class="cinder-tool-picker__empty-hint cinder-tool-picker__none">{emptyLabel}</p>
    {:else if empty}
      <div class="cinder-tool-picker__empty">
        <p class="cinder-tool-picker__empty-title">{emptyTitle}</p>
        <p class="cinder-tool-picker__empty-hint">{noMatchHint}</p>
        <Button size="sm" variant="secondary" onclick={clearSearch}>{clearSearchLabel}</Button>
      </div>
    {:else}
      {#each visibleSections as section, position (section.name)}
        {@const headerId = `${baseId}-group-${position}`}
        {@const listId = `${baseId}-list-${position}`}
        {@const open_ = expanded(section.name, position)}
        <div class="cinder-tool-picker__group" role="group" aria-labelledby={headerId}>
          {#if longList && !searching}
            <h3 class="cinder-tool-picker__group-heading" id={headerId}>
              <button
                type="button"
                class="cinder-tool-picker__group-toggle"
                aria-expanded={open_}
                aria-controls={listId}
                onclick={() => toggleGroup(section.name, position)}
              >
                {#if open_}<ChevronDown aria-hidden="true" />{:else}<ChevronRight
                    aria-hidden="true"
                  />{/if}
                <span class="cinder-tool-picker__group-name">{section.name}</span>
                <span class="cinder-tool-picker__group-count">{groupSummary(section)}</span>
              </button>
            </h3>
          {:else}
            <h3 class="cinder-tool-picker__group-heading" id={headerId}>
              <span class="cinder-tool-picker__group-name">{section.name}</span><span
                class="cinder-tool-picker__group-count"
              >
                {#if longList}{` ${groupSummary(section)}`}{:else}{`, ${groupSummary(section)}`}{/if}
              </span>
            </h3>
          {/if}
          {#if open_}
            <ul class="cinder-tool-picker__rows" id={listId} role="list">
              {#each section.items as item (item.value)}
                {@const selectable = isSelectable(item)}
                {@const rowId = `${baseId}-item-${itemIndex.get(item.value) ?? 0}`}
                <li
                  class="cinder-tool-picker__row"
                  data-cinder-selected={selectable && chosen.has(item.value) ? '' : undefined}
                  data-cinder-readonly={selectable ? undefined : ''}
                >
                  <span class="cinder-tool-picker__control">
                    {#if selectable}
                      <Checkbox
                        id={rowId}
                        aria-label={item.label}
                        aria-describedby={item.description ? `${rowId}-description` : undefined}
                        checked={chosen.has(item.value)}
                        onValueChange={(next) => setChosen(item, next)}
                      />
                    {/if}
                  </span>
                  <svelte:element
                    this={selectable ? 'label' : 'div'}
                    class="cinder-tool-picker__text"
                    for={selectable ? rowId : undefined}
                  >
                    <span class="cinder-tool-picker__heading">
                      <span class="cinder-tool-picker__name">{item.label}</span>
                      {#if item.code}<code class="cinder-tool-picker__code">{item.code}</code>{/if}
                      {#if item.suffix}<span class="cinder-tool-picker__suffix"
                          >, {item.suffix}</span
                        >{/if}
                    </span>
                    {#if item.description}
                      <span class="cinder-tool-picker__description" id={`${rowId}-description`}
                        >{item.description}</span
                      >
                    {/if}
                  </svelte:element>
                  {#if showMeta}
                    {#if item.meta}
                      <span class="cinder-tool-picker__meta">{item.meta}</span>
                    {:else}
                      <span class="cinder-tool-picker__meta" role="img" aria-label={emptyMetaLabel}
                        >—</span
                      >
                    {/if}
                  {/if}
                  {#if showDetail}
                    <span class="cinder-tool-picker__detail">{item.detail ?? ''}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={handleCancel}>{cancelLabel}</Button>
    <Button variant="primary" disabled={loading} onclick={handleDone}>{doneLabel}</Button>
  {/snippet}
</Modal>
