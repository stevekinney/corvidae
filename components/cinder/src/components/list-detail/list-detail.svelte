<script lang="ts" module>
  /**
   * @cinder
   * @category layout
   * @status beta
   * @purpose Resizable list-and-detail layout with a list header, keyboard selection, the open item kept in the URL, a remembered divider width, and a one-pane-at-a-time layout on narrow containers.
   * @tag layout
   * @tag list
   * @tag detail
   * @tag selection
   * @tag master-detail
   * @useWhen Browsing a collection of records where choosing one shows it beside the list, such as chats, runs, or memories.
   * @useWhen The open record must survive a reload and be shareable as a link.
   * @avoidWhen Each record has its own page and the list is only a way to navigate there. | stacked-list-item
   * @avoidWhen You need the resizable layout alone, with no list. | resizable-panels
   * @related resizable-panels, data-list, selectable-row, empty-state
   * @a11yPattern Region landmarks with a native button or link row action
   * @keyboardShortcut J | Moves the keyboard cursor to the next row.
   * @keyboardShortcut K | Moves the keyboard cursor to the previous row.
   * @keyboardShortcut Enter | Opens the row the cursor is on.
   * @a11yNote J and K are ignored while focus is in a text field, a menu, a listbox, a combobox or a dialog, so typing is never taken.
   */
  export type {
    ListDetailProps,
    ListDetailRowContext,
    ListDetailSelectionLocation,
    ListDetailStorage,
  } from './list-detail.types.ts';
</script>

<script lang="ts" generics="T">
  import { tick, untrack } from 'svelte';

  import { classNames } from '../../utilities/class-names.ts';
  import { useResizeObserver } from '../../utilities/use-resize-observer.svelte.ts';
  import { Button } from '../button/index.ts';
  import { DataList } from '../data-list/index.ts';
  import { EmptyState } from '../empty-state/index.ts';
  import { ChevronLeft } from '../icons/index.ts';
  import { ResizablePanels } from '../resizable-panels/index.ts';
  import type {
    ResizablePanelDefinition,
    ResizablePanelsResizeEvent,
  } from '../resizable-panels/index.ts';
  import {
    createBrowserSelectionLocation,
    clampListWidth,
    DETAIL_PANE_MINIMUM_WIDTH,
    LIST_PANE_MAXIMUM_WIDTH,
    LIST_PANE_MINIMUM_WIDTH,
    moveCursor,
    ownsTypedKeys,
    readStoredListWidth,
    resolveStorage,
    writeStoredListWidth,
  } from './list-detail-state.ts';
  import type { ListDetailProps } from './list-detail.types.ts';

  let {
    items,
    key,
    label,
    list,
    detail,
    empty,
    listEmpty,
    header,
    selectedKey = $bindable(null),
    onSelectedKeyChange,
    selectionParameter = 'selected',
    selectionLocation,
    storageKey,
    storage,
    pushBelow = 900,
    defaultListWidth = 320,
    backLabel = 'Back',
    detailLabel = 'Details',
    emptyTitle = 'Nothing selected',
    emptyDescription = 'Choose an item from the list to see it here.',
    class: className,
    ...rest
  }: ListDetailProps<T> = $props();

  const ROW_SELECTOR = 'li[data-cinder-list-detail-key]';
  const ROW_KEY_ATTRIBUTE = 'data-cinder-list-detail-key';

  let rootElement: HTMLDivElement | undefined = $state();
  let rootWidth = $state(0);
  let activeKey = $state<string | null>(null);

  const keys = $derived(items.map((item) => key(item)));
  // An entry, not the item, so an item that is itself `undefined` is still found.
  const selectedEntry = $derived.by(() => {
    const index = selectedKey === null ? -1 : keys.indexOf(selectedKey);
    return index === -1 ? undefined : { item: items[index] as T };
  });
  // An unmeasured root (the server, the first paint) is treated as wide, so the stacked layout
  // never flashes before the width is known.
  const narrow = $derived(rootWidth > 0 && rootWidth < pushBelow);

  // The divider starts where it was left. This is read when the panels mount, not on every render:
  // later drags are the person's, not a prop's, so a new `defaultListWidth` does not move a divider
  // that is already placed, and changing it while mounted would reset the layout mid-drag.
  let initialListWidth = $state(
    untrack(() =>
      clampListWidth(readStoredListWidth(resolveStorage(storage), storageKey) ?? defaultListWidth),
    ),
  );
  // The last width the person dragged to, for a remount when there is no storage to read it from.
  let draggedListWidth: number | null = null;
  let wasNarrow = false;
  // Narrowing unmounts the panels and widening mounts new ones, which start from
  // `initialListWidth`, so refresh it from where the divider was left before they do.
  $effect.pre(() => {
    const isNarrow = narrow;
    untrack(() => {
      if (wasNarrow && !isNarrow) {
        const stored = readStoredListWidth(resolveStorage(storage), storageKey);
        const width = stored ?? draggedListWidth;
        if (width !== null) initialListWidth = clampListWidth(width);
      }
      wasNarrow = isNarrow;
    });
  });
  const panes = $derived<ResizablePanelDefinition[]>([
    {
      id: 'list',
      label,
      defaultSize: { value: initialListWidth, unit: 'px' },
      minSize: { value: LIST_PANE_MINIMUM_WIDTH, unit: 'px' },
      maxSize: { value: LIST_PANE_MAXIMUM_WIDTH, unit: 'px' },
    },
    {
      id: 'detail',
      label: detailLabel,
      // Zero, so the detail asks for only its minimum and takes whatever the list leaves. Without a
      // default it would ask for an equal share, and a list wider than half the container would be
      // squeezed to make room for it.
      defaultSize: { value: 0, unit: 'px' },
      minSize: { value: DETAIL_PANE_MINIMUM_WIDTH, unit: 'px' },
    },
  ]);

  function measureRoot(): void {
    if (rootElement) rootWidth = rootElement.getBoundingClientRect().width;
  }

  const resizeAttachment = useResizeObserver(() => {
    measureRoot();
  });

  $effect(() => {
    if (rootElement) measureRoot();
  });

  function commitLayout(event: ResizablePanelsResizeEvent): void {
    // A rebase is the container changing size, not the person moving the divider.
    if (event.reason === 'rebase') return;
    const listSize = event.sizes.find((size) => size.id === 'list');
    if (!listSize) return;
    draggedListWidth = listSize.pixelSize;
    writeStoredListWidth(resolveStorage(storage), storageKey, listSize.pixelSize);
  }

  // The selection and the URL. On the first run an empty selection is filled from the URL, while an
  // explicit one is kept and written to it; after that the URL follows the selection, and only when
  // it differs, so a reload lands where it left.
  let urlReady = false;
  $effect(() => {
    const parameter = selectionParameter;
    const current = selectedKey;
    if (parameter === null) return;
    const location = selectionLocation ?? createBrowserSelectionLocation();
    if (!urlReady) {
      urlReady = true;
      if (current === null) {
        const fromUrl = location.read(parameter);
        if (fromUrl === null || fromUrl === '') return;
        untrack(() => {
          selectedKey = fromUrl;
          activeKey = fromUrl;
          onSelectedKeyChange?.(fromUrl);
        });
        return;
      }
    }
    if (location.read(parameter) !== current) location.write(parameter, current);
  });

  function rowElements(): HTMLElement[] {
    return rootElement ? [...rootElement.querySelectorAll<HTMLElement>(ROW_SELECTOR)] : [];
  }

  function rowElementFor(rowKey: string): HTMLElement | undefined {
    return rowElements().find((row) => row.getAttribute(ROW_KEY_ATTRIBUTE) === rowKey);
  }

  function rowKeyOf(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest(ROW_SELECTOR)?.getAttribute(ROW_KEY_ATTRIBUTE) ?? null;
  }

  function isRowPrimaryAction(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.cinder-selectable-row__primary') !== null;
  }

  async function focusRow(rowKey: string): Promise<void> {
    await tick();
    const row = rowElementFor(rowKey);
    const control =
      row?.querySelector<HTMLElement>('.cinder-selectable-row__primary') ??
      row?.querySelector<HTMLElement>('a[href], button:not(:disabled)');
    control?.focus();
  }

  function setSelection(next: string | null): void {
    if (next === selectedKey) return;
    selectedKey = next;
    if (next !== null) activeKey = next;
    onSelectedKeyChange?.(next);
  }

  async function open(rowKey: string): Promise<void> {
    setSelection(rowKey);
    if (!narrow) return;
    // The list is gone below `pushBelow`, so focus moves to the first control of the detail.
    await tick();
    rootElement?.querySelector<HTMLElement>('.cinder-list-detail__back button')?.focus();
  }

  async function back(): Promise<void> {
    const returnTo = selectedKey;
    setSelection(null);
    if (returnTo !== null) await focusRow(returnTo);
  }

  function handleClick(event: MouseEvent): void {
    const rowKey = rowKeyOf(event.target);
    if (rowKey !== null && isRowPrimaryAction(event.target)) void open(rowKey);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter') {
      const rowKey = rowKeyOf(event.target);
      if (rowKey !== null && isRowPrimaryAction(event.target)) void open(rowKey);
      return;
    }
    const step =
      event.key === 'j' || event.key === 'J'
        ? 1
        : event.key === 'k' || event.key === 'K'
          ? -1
          : null;
    if (step === null || ownsTypedKeys(event.target)) return;
    const next = moveCursor(keys, activeKey ?? selectedKey, step);
    if (next === null) return;
    event.preventDefault();
    activeKey = next;
    void focusRow(next);
  }
</script>

{#snippet listPane()}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    class="cinder-list-detail__list"
    aria-label={label}
    aria-keyshortcuts="J K Enter"
    onclick={handleClick}
    onkeydown={handleKeydown}
  >
    {#if header}
      <header class="cinder-list-detail__header">{@render header()}</header>
    {/if}
    <div class="cinder-list-detail__rows">
      <DataList {items} {key} {...listEmpty ? { empty: listEmpty } : {}}>
        {#snippet children(item)}
          {@const rowKey = key(item)}
          <li
            class="cinder-list-detail__row"
            data-cinder-list-detail-key={rowKey}
            data-cinder-active={activeKey === rowKey ? '' : undefined}
          >
            {@render list(item, {
              selected: selectedKey === rowKey,
              active: activeKey === rowKey,
              open: () => void open(rowKey),
            })}
          </li>
        {/snippet}
      </DataList>
    </div>
  </section>
{/snippet}

{#snippet detailPane()}
  <section class="cinder-list-detail__detail" aria-label={detailLabel}>
    {#if narrow}
      <div class="cinder-list-detail__back">
        <Button variant="ghost" size="sm" onclick={() => void back()}>
          {#snippet leadingIcon()}<ChevronLeft
              class="cinder-icon-sm"
              aria-hidden="true"
            />{/snippet}
          {backLabel}
        </Button>
      </div>
    {/if}
    <div class="cinder-list-detail__detail-body">
      {#if selectedEntry}
        {@render detail(selectedEntry.item)}
      {:else if empty}
        {@render empty()}
      {:else}
        <EmptyState title={emptyTitle} description={emptyDescription} />
      {/if}
    </div>
  </section>
{/snippet}

<div
  {...rest}
  bind:this={rootElement}
  {@attach resizeAttachment}
  class={classNames('cinder-list-detail', className)}
  data-cinder-layout={narrow ? 'stacked' : 'split'}
>
  {#if narrow}
    {#if selectedEntry}
      {@render detailPane()}
    {:else}
      {@render listPane()}
    {/if}
  {:else}
    <ResizablePanels {panes} class="cinder-list-detail__panels" onLayoutCommit={commitLayout}>
      {#snippet children(pane)}
        {#if pane.id === 'list'}
          {@render listPane()}
        {:else}
          {@render detailPane()}
        {/if}
      {/snippet}
    </ResizablePanels>
  {/if}
</div>
