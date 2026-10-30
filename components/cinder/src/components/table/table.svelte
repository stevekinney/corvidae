<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Composite root that establishes table semantics, density, and sort context for nested header, body, row, and cell parts.
   * @tag table
   * @tag grid
   * @useWhen Comparing rows of structured records across consistent columns.
   * @useWhen Coordinating column sort state across header cells via the sort prop.
   * @avoidWhen Rendering a responsive card grid — use grid-list instead.
   * @avoidWhen Listing key-value attributes of one entity — use description-list instead.
   * @related data-table, data-grid, table-header, table-body, table-row, table-cell, table-header-cell
   */
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
  import type { Attachment } from 'svelte/attachments';

  import { setTableContext } from './table.context.ts';
  import type { TableProps } from './table.types.ts';

  import {
    PHONE_VIEWPORT_BREAKPOINT,
    readViewportBreakpoint,
    useViewportBelow,
  } from '../../_internal/viewport-below.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { useResizeObserver } from '../../utilities/use-resize-observer.svelte.ts';
  import { overflowShadow } from '../../utilities/attachments.ts';

  let {
    sort = $bindable(),
    caption,
    stickyHeader = false,
    density = 'comfortable',
    selectable = false,
    scrollable = false,
    scrollContainerProps,
    stackBelow = PHONE_VIEWPORT_BREAKPOINT,
    class: className,
    children,
    ...rest
  }: TableProps = $props();

  const stackBreakpoint = $derived(readViewportBreakpoint(stackBelow, 'Table', 'stackBelow'));
  const narrowViewport = useViewportBelow(() => stackBreakpoint);
  const stacked = $derived(narrowViewport.current);

  // A stacked cell shows its column's header text above its value. The header
  // row is the one source of those names, so copy each header cell's text onto
  // the body cell in the same column, and keep it current as rows, headers, or
  // header text change. Cells in a row that spans columns keep whatever name
  // their position gives them; a header cell with no text names nothing.
  const STACK_LABEL_ATTRIBUTE = 'data-cinder-stack-label';

  function labelStackedCells(table: HTMLTableElement): void {
    const headerRow = table.querySelector(':scope > thead > tr');
    const labels = headerRow
      ? Array.from(headerRow.children, (cell) => cell.textContent?.trim() ?? '')
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

  const labelCellsWhileStacked: Attachment<HTMLTableElement> = (table) => {
    if (!stacked) return;
    const roled = new Set<Element>();
    const update = (): void => {
      labelStackedCells(table);
      keepTableRoles(table, roled);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(table, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
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

  setTableContext({
    get sort() {
      return sort;
    },
    get selectionEnabled() {
      return selectable;
    },
    onSortChange,
  });
</script>

{#snippet table()}
  <table
    {...rest}
    class={classNames('cinder-table', className)}
    data-cinder-sticky-header={stickyHeader || undefined}
    data-cinder-density={density}
    data-cinder-selectable={selectable || undefined}
    data-cinder-stacked={stacked || undefined}
    style:--cinder-table-caption-height={normalizedCaption ? `${captionHeight}px` : undefined}
    {@attach labelCellsWhileStacked}
  >
    {#if normalizedCaption}
      <caption class="cinder-table__caption" {@attach measureCaption}>{normalizedCaption}</caption>
    {/if}
    {@render children()}
  </table>
{/snippet}

{#if scrollable}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    {...scrollContainerProps}
    class={classNames('cinder-table-scroll', wrapperClassName)}
    role={wrapperRole}
    aria-label={wrapperAriaLabel}
    aria-labelledby={wrapperAriaLabelledBy}
    tabindex={wrapperTabindex}
    {@attach overflowShadow('inline')}
  >
    {@render table()}
  </div>
{:else}
  {@render table()}
{/if}
