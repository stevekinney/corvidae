<script lang="ts" module>
  export type {
    SortDirection,
    TableContext,
    TableDensity,
    TableHeaderSelectionContext,
    TableProps,
    TableSectionContext,
    TableSort,
  } from './table.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { SvelteMap } from 'svelte/reactivity';

  import Select from '../select/select.svelte';
  import { holdSortButtonsOutOfTabOrder, markCardCells } from './table-stack.ts';
  import { lengthToPixels } from './table.length.ts';
  import { getTableContainerProvided } from './table-container-context.ts';
  import { stackStyle, stylesheetCoversLength } from './table-stack-rules.ts';
  import { setTableContext } from './table.context.ts';
  import type { TableColumnSizing, TableProps } from './table.types.ts';

  import {
    PHONE_VIEWPORT_BREAKPOINT,
    readViewportBreakpoint,
    useViewportBelow,
  } from '../../_internal/viewport-below.svelte.ts';
  import { getFramedSurfaceContext } from '../../_internal/framed-surface-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { useResizeObserver } from '../../utilities/use-resize-observer.svelte.ts';
  import { overflowFadeEdges } from '../../utilities/attachments.ts';

  const FIT_STACK_BREAKPOINT = '26rem';

  let {
    sort = $bindable(),
    caption,
    stickyHeader = false,
    density = 'comfortable',
    selectable = false,
    scrollable = true,
    frameless: framelessProp = false,
    framed = false,
    fit = false,
    sortable = false,
    scrollContainerProps,
    stackBelow,
    class: className,
    children,
    ...rest
  }: TableProps = $props();

  // Inside a Card the card is the frame, so the table draws none unless `framed` keeps it.
  const insideFramedSurface = getFramedSurfaceContext() === true;
  const frameless = $derived(framelessProp || (insideFramedSurface && !framed));

  let hasFillControls = $state(false);
  // A `fit` table that stacks as flat rows (no control fills its cell) reads well down to a narrow
  // column, so it stacks only below 26rem (416px); the control layout keeps a phone's 640px.
  const stackBreakpoint = $derived(
    readViewportBreakpoint(
      stackBelow ?? (fit && !hasFillControls ? FIT_STACK_BREAKPOINT : PHONE_VIEWPORT_BREAKPOINT),
      'Table',
      'stackBelow',
    ),
  );
  const narrowViewport = useViewportBelow(() => stackBreakpoint);

  // A table stacks only while one of its cells holds a control, and by the width of the box it sits
  // in, not the window: a table in a narrow column stacks in a wide window, and a table in a wide
  // column does not stack in a narrow one. The container is the table's parent (the scroll wrapper
  // when `scrollable`). Until the container has a measurable width (the server, the first paint,
  // an engine with no layout) the viewport stands in for it.
  let controlRegistrations = 0;
  let fillRegistrations = 0;
  let hasControls = $state(false);
  let containerNarrow = $state<boolean | undefined>(undefined);
  // A `fit` table stacks too, as cards, unless a control that fills its cell asks for the control
  // layout (a table of form fields, where each control keeps a line of its own).
  const stacked = $derived((hasControls || fit) && (containerNarrow ?? narrowViewport.current));
  const stackCard = $derived(stacked && fit && !hasFillControls);

  function registerControls(fill = true): () => void {
    // Plain counters, so registering inside a cell's effect never reads the state it writes.
    controlRegistrations += 1;
    if (fill) fillRegistrations += 1;
    hasControls = true;
    hasFillControls = fillRegistrations > 0;
    return () => {
      controlRegistrations -= 1;
      if (fill) fillRegistrations -= 1;
      hasControls = controlRegistrations > 0;
      hasFillControls = fillRegistrations > 0;
    };
  }

  // CSS chooses the stacked form (COR-2771): a size container query on `.cinder-table-container`
  // reads the table's server HTML (`data-cinder-fit`, each cell's `data-cinder-controls`), so the
  // first paint is already the right form. `data-cinder-stack-below` names an explicit length;
  // `table.css` holds the rules for the defaults and for 640px, and any other length brings the
  // same rules in a `<style>` of its own, whose only value is that validated length.
  const stackBelowAttribute = $derived(
    stackBelow === false ? 'false' : stackBelow === undefined ? undefined : stackBreakpoint,
  );
  const ownStackStyle = $derived(
    typeof stackBelow === 'string' &&
      stackBreakpoint !== undefined &&
      !stylesheetCoversLength(stackBreakpoint)
      ? stackStyle(stackBreakpoint)
      : undefined,
  );
  // A component that renders the size container around its own scroll box (DataTable) says so.
  const containerProvided = getTableContainerProvided() === true;

  // Script still watches the container for what CSS cannot do after hydration (the sort control
  // above the cards, the sort buttons held out of the tab order, keeping marks current). It changes
  // no geometry: `data-cinder-stacked` and `data-cinder-stack-card` are hooks, never layout.
  const measureContainer: Attachment<HTMLTableElement> = (table) => {
    const container = table.closest('.cinder-table-container') ?? table.parentElement;
    const breakpoint = stackBreakpoint;
    // Only a table that can stack (a control in it, or `fit`) watches its container.
    if (
      !container ||
      breakpoint === undefined ||
      !(hasControls || fit) ||
      typeof ResizeObserver === 'undefined'
    ) {
      containerNarrow = undefined;
      return;
    }
    // Against the container, as the container query resolves an `em` length, not the table.
    const threshold = lengthToPixels(breakpoint, container);
    const update = (width: number): void => {
      containerNarrow = threshold === undefined || !(width > 0) ? undefined : width < threshold;
    };
    update(container.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      // No entries (an empty list, or none passed): measure the container itself.
      const entry = (entries as ResizeObserverEntry[] | undefined)?.at(-1);
      update(entry ? entry.contentRect.width : container.getBoundingClientRect().width);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      containerNarrow = undefined;
    };
  };

  // A stacked cell shows its column's header text above its value. The header
  // row is the one source of those names, so copy each header cell's text onto
  // the body cell in the same column, and keep it current as rows, headers, or
  // header text change. Cells in a row that spans columns keep whatever name
  // their position gives them; a header cell with no text names nothing.
  const STACK_LABEL_ATTRIBUTE = 'data-cinder-stack-label';

  function labelStackedCells(table: HTMLTableElement): void {
    const headerRow = table.querySelector(':scope > thead > tr');
    // A header cell's declared `label` (also in the server's HTML) wins over its visible text.
    const labels = headerRow
      ? Array.from(
          headerRow.children,
          (cell) => cell.getAttribute('data-cinder-label') ?? cell.textContent?.trim() ?? '',
        )
      : [];
    for (const row of Array.from(table.querySelectorAll(':scope > tbody > tr'))) {
      Array.from(row.children).forEach((cell, index) => {
        const label = labels[index];
        if (label) {
          if (cell.getAttribute(STACK_LABEL_ATTRIBUTE) !== label) {
            cell.setAttribute(STACK_LABEL_ATTRIBUTE, label);
          }
        } else if (cell.hasAttribute(STACK_LABEL_ATTRIBUTE)) {
          cell.removeAttribute(STACK_LABEL_ATTRIBUTE);
        }
      });
    }
  }

  // `display: block` on table parts makes some engines (Safari among them) drop
  // their table semantics, so while stacked each part also carries its table
  // role explicitly. Only parts without a role of their own get one, and the
  // roles come off again when the table unstacks.
  function tableRole(element: Element): string | undefined {
    switch (element.tagName) {
      case 'TABLE':
        return 'table';
      case 'THEAD':
      case 'TBODY':
      case 'TFOOT':
        return 'rowgroup';
      case 'TR':
        return 'row';
      case 'TD':
        return 'cell';
      case 'TH':
        return element.parentElement?.parentElement?.tagName === 'THEAD'
          ? 'columnheader'
          : 'rowheader';
      default:
        return undefined;
    }
  }

  function keepTableRoles(table: HTMLTableElement, roled: Set<Element>): void {
    const parts: Element[] = [table];
    for (const section of Array.from(table.children)) {
      parts.push(section);
      for (const row of Array.from(section.children)) {
        parts.push(row, ...Array.from(row.children));
      }
    }
    for (const part of parts) {
      if (roled.has(part) || part.hasAttribute('role')) continue;
      const role = tableRole(part);
      if (role === undefined) continue;
      part.setAttribute('role', role);
      roled.add(part);
    }
  }

  // A stacked sortable `fit` table sorts from one Select above the rows: its options are the sortable
  // columns the header names, and choosing one activates that column's header button.
  // Each sortable header cell registers its column as it is created, as it does its label, so the
  // options are in place before the Select's first effect runs. The server's HTML renders the
  // control before the header cells, so it carries the control's row with no options, and
  // hydration fills them in (COR-2771). Entries are keyed by the header cell, not its position: a
  // cell that moves (after mount, to its DOM position) holds one entry throughout, so the options
  // never list a column twice, even for the moment between its two registrations.
  const sortColumns = new SvelteMap<object, { position: number; column: string; label: string }>();
  const sortOptions = $derived(
    [...sortColumns.values()]
      .sort((a, b) => a.position - b.position)
      // One column key is one way to sort, however many header cells name it.
      .filter(
        (entry, index, entries) =>
          entries.findIndex((other) => other.column === entry.column) === index,
      )
      .flatMap(({ column, label }) => [
        { value: `ascending:${column}`, label: `${label} ascending` },
        { value: `descending:${column}`, label: `${label} descending` },
      ]),
  );
  // The control shows the sort that is applied, however it was set (the `sort` prop, a header
  // button while wide, or the control itself), and "Sort by" while none of its options is.
  const selectedSort = $derived.by(() => {
    if (!sort) return '';
    const applied = `${sort.direction}:${sort.column}`;
    return sortOptions.some((option) => option.value === applied) ? applied : '';
  });
  const instanceId = $props.id();
  const sortSelectId = `cinder-table-sort-${instanceId}`;
  // Sorting by a column, as its header button does, once or twice to reach the chosen direction.
  // The sort already applied is left as it is: one more press would turn it around.
  function chooseSort(value: string): void {
    const split = value.indexOf(':');
    const direction = value.slice(0, split);
    const column = value.slice(split + 1);
    if (![...sortColumns.values()].some((entry) => entry.column === column)) return;
    if (sort?.column === column && sort.direction === direction) return;
    onSortChange(column);
    if (sort?.direction !== direction) onSortChange(column);
  }

  // A press on the sort control's hit area, outside the drawn select, opens the select.
  function openSortPicker(event: MouseEvent): void {
    const { target, currentTarget } = event;
    if (!(target instanceof HTMLElement) || !(currentTarget instanceof HTMLElement)) return;
    if (target.closest('select, .cinder-select-field__chevron')) return;
    currentTarget.querySelector('select')?.showPicker?.();
  }

  const labelCellsWhileStacked: Attachment<HTMLTableElement> = (table) => {
    if (!stacked) return;
    const card = stackCard;
    const roled = new Set<Element>();
    const releaseSortButtons = card ? holdSortButtonsOutOfTabOrder(table) : undefined;
    const update = (): void => {
      labelStackedCells(table);
      keepTableRoles(table, roled);
      if (!card) return;
      markCardCells(table);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(table, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      releaseSortButtons?.();
      // The title and empty marks stay: the server's HTML carries them, and only the card rules,
      // which apply below the stack width, read them.
      for (const part of roled) part.removeAttribute('role');
    };
  };

  const wrapperClassName = $derived(scrollContainerProps?.class);
  const wrapperAriaLabelledBy = $derived(
    normalizeOptionalAttribute(scrollContainerProps?.['aria-labelledby']),
  );
  const explicitWrapperAriaLabel = $derived(
    normalizeOptionalAttribute(scrollContainerProps?.['aria-label']),
  );
  const explicitWrapperRole = $derived(normalizeOptionalAttribute(scrollContainerProps?.role));
  const normalizedCaption = $derived(normalizeOptionalAttribute(caption));
  const wrapperAriaLabel = $derived(
    explicitWrapperAriaLabel ??
      (wrapperAriaLabelledBy
        ? undefined
        : normalizedCaption
          ? `${normalizedCaption} table scroll area`
          : undefined),
  );
  const wrapperRole = $derived(
    explicitWrapperRole ?? (wrapperAriaLabel || wrapperAriaLabelledBy ? 'region' : undefined),
  );
  const wrapperTabindex = $derived(normalizeOptionalTabindex(scrollContainerProps?.tabindex) ?? 0);

  function normalizeOptionalAttribute(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  function normalizeOptionalTabindex(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value)) return value;

    if (typeof value !== 'string') return undefined;

    const normalizedValue = value.trim();
    if (!/^-?\d+$/.test(normalizedValue)) return undefined;

    return Number(normalizedValue);
  }

  // A native <caption> (caption-side: top) renders above the table's border box
  // but inside the same scroll container, so a sticky <thead> pinned at top: 0
  // would overlap it. The caption's height is not knowable in pure CSS — `1lh`
  // would assume a single line and break when the caption wraps (narrow
  // container, long/localized text, large text settings). Measure the caption's
  // border-box block size and expose it as a custom property the sticky `top`
  // calc consumes, so the header always pins just below the real caption.
  let captionHeight = $state(0);

  // Only the sticky-header `top` calc consumes `captionHeight`, so a non-sticky
  // captioned table has no reason to run a ResizeObserver. Gate observation on
  // `stickyHeader` to avoid the work in the common case.
  const measureCaption = useResizeObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry) return;
      captionHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
    },
    { box: 'border-box', enabled: () => stickyHeader },
  );

  function onSortChange(column: string): void {
    if (!sort || sort.column !== column) {
      sort = { column, direction: 'ascending' };
      return;
    }
    // Same column — toggle direction.
    sort = {
      column,
      direction: sort.direction === 'ascending' ? 'descending' : 'ascending',
    };
  }

  // The `sizing` each header cell declares, by column position. A header cell writes it as it is
  // created, before the body cells under it are, so the server's HTML already carries each body
  // cell's sizing and the first paint is the sized layout.
  // Each entry names the header cell that wrote it, so a cell that moves to another position (after
  // mount, to its DOM `cellIndex`) withdraws only its own entry, never a neighbour's that has just
  // moved in.
  const columnSizings = new SvelteMap<number, { owner: object; sizing: TableColumnSizing }>();
  // Each column's label, written the same way, so a body cell prints it beside its value while
  // stacked, from the server's HTML on (COR-2771).
  const columnLabels = new SvelteMap<number, { owner: object; label: string }>();

  setTableContext({
    setColumnSizing(column, sizing, owner) {
      if (column < 0) return;
      // A write, never a dependency of the effect that calls it.
      untrack(() => {
        if (sizing !== undefined) columnSizings.set(column, { owner, sizing });
        else if (columnSizings.get(column)?.owner === owner) columnSizings.delete(column);
      });
    },
    columnSizing(column) {
      return column < 0 ? undefined : columnSizings.get(column)?.sizing;
    },
    setColumnLabel(column, label, owner) {
      if (column < 0) return;
      untrack(() => {
        if (label !== undefined && label !== '') columnLabels.set(column, { owner, label });
        else if (columnLabels.get(column)?.owner === owner) columnLabels.delete(column);
      });
    },
    columnLabel(column) {
      return column < 0 ? undefined : columnLabels.get(column)?.label;
    },
    get sort() {
      return sort;
    },
    get selectionEnabled() {
      return selectable;
    },
    get stackCard() {
      return stackCard;
    },
    get fit() {
      return fit;
    },
    get sortable() {
      return sortable;
    },
    setSortColumn(position, column, label, owner) {
      if (position < 0) return;
      untrack(() => {
        if (column !== undefined)
          sortColumns.set(owner, { position, column, label: label || column });
        else if (sortColumns.get(owner)?.position === position) sortColumns.delete(owner);
      });
    },
    onSortChange,
    registerControls,
  });
</script>

{#snippet table()}
  <!-- A `fit` table can stack, and `display: block` drops table semantics in some engines (Safari
       among them), so its parts carry their table roles in the server HTML. They are spread, since
       the roles repeat each element's own. -->
  <table
    {...rest}
    {...fit ? { role: 'table' } : {}}
    class={classNames('cinder-table', className)}
    data-cinder-sticky-header={stickyHeader || undefined}
    data-cinder-density={density}
    data-cinder-selectable={selectable || undefined}
    data-cinder-stacked={stacked || undefined}
    data-cinder-stack-card={stackCard || undefined}
    data-cinder-frameless={frameless || undefined}
    data-cinder-fit={fit || undefined}
    data-cinder-stack-below={stackBelowAttribute}
    style:--cinder-table-caption-height={normalizedCaption ? `${captionHeight}px` : undefined}
    {@attach measureContainer}
    {@attach labelCellsWhileStacked}
  >
    {#if normalizedCaption}
      <caption class="cinder-table__caption" {@attach measureCaption}>{normalizedCaption}</caption>
    {/if}
    {@render children()}
  </table>
{/snippet}

{#snippet contents()}
  {#if ownStackStyle !== undefined}
    <svelte:element this={"style"}>{ownStackStyle}</svelte:element>
  {/if}
  <!-- The sort control's row is in the server's HTML of a `sortable` `fit` table, and CSS shows it
       only while the table takes the card form (`table-stack-rules.ts`), so the first paint already
       holds its place. Its options are read from the header once mounted (COR-2771). -->
  {#if fit && (sortable || sortOptions.length > 0)}
    <div class="cinder-table__stack-sort">
      <!-- The select is drawn compact, so this box carries its 44px hit area: a press that lands in
           the padding above or below it opens the select too. The keyboard uses the select itself. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="cinder-table__stack-sort-hit" onclick={openSortPicker}>
        <Select
          id={sortSelectId}
          label="Sort by"
          labelVisible={false}
          size="sm"
          variant="ghost"
          presentation="native"
          options={[
            // A native select shows its selected option, and with no sort applied that is this
            // one: the control says "Sort by" from the server's HTML on, never a sort that is not
            // applied, and every real option can be chosen (design review, round 2).
            { value: '', label: 'Sort by', disabled: true },
            ...sortOptions.map((option) => ({ ...option, label: `Sort: ${option.label}` })),
          ]}
          value={selectedSort}
          disabled={sortOptions.length === 0}
          onValueChange={chooseSort}
        />
      </div>
    </div>
  {/if}

  {#if scrollable}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      {...scrollContainerProps}
      class={classNames('cinder-table-scroll', 'cinder-_scroll-fade-inline-end', wrapperClassName)}
      role={wrapperRole}
      aria-label={wrapperAriaLabel}
      aria-labelledby={wrapperAriaLabelledBy}
      tabindex={wrapperTabindex}
      data-cinder-frameless={frameless || undefined}
      data-cinder-stack-card={stackCard || undefined}
      {@attach overflowFadeEdges('inline')}
    >
      {@render table()}
    </div>
  {:else}
    {@render table()}
  {/if}
{/snippet}

<!-- The table's own container: the size container its stacked forms query. A component that renders
     it around its own scroll box (DataTable) leaves it out here. -->
{#if containerProvided}
  {@render contents()}
{:else}
  <div
    class="cinder-table-container"
    data-cinder-fit={fit || undefined}
    data-cinder-stack-below={stackBelowAttribute}
  >
    {@render contents()}
  </div>
{/if}
