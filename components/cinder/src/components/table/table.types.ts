import type { Snippet } from 'svelte';
import type { HTMLAttributes, HTMLTableAttributes } from 'svelte/elements';
/** Sort direction. */
export type SortDirection = 'ascending' | 'descending';
/** Bound sort state shape. */
export type TableSort = {
  /** Column key currently sorted by. */
  column: string;
  /** Direction of the active sort. */
  direction: SortDirection;
};
/** Vertical padding density for all cells in the table. */
export type TableDensity = 'comfortable' | 'condensed' | 'spacious';
/** Section context value — set by TableHeader and TableBody, read by TableRow. */
export type TableSectionContext = 'header' | 'body';
/**
 * Context set by TableHeader with select-all state, read by the header TableRow
 * to render the leading select-all checkbox cell.
 */
export type TableHeaderSelectionContext = {
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly onSelectAll: (next: boolean) => void;
  readonly selectAllLabel: string;
  claimSelectionHeaderCell: () => void;
};
/**
 * Shape of the table context provided to child components. Header cells call
 * `onSortChange` with their column key when activated; the table propagates
 * the new sort state to its bindable `sort` prop. Children read
 * `selectionEnabled` to render the leading selection cell.
 *
 * @internal This type describes the context object produced by Table. It is
 * not intended to be implemented or constructed by consumers — use `getContext`
 * to read it, not `setContext` to provide it.
 */
export type TableContext = {
  readonly sort: TableSort | undefined;
  onSortChange: (column: string) => void;
  /** Mirror of Table.selectable. Set synchronously at construction time. */
  readonly selectionEnabled?: boolean;
  /**
   * Called by a cell that holds a control while it is mounted. A table that is not `fit` stacks
   * its rows only while at least one cell is registered. `fill` is false for a control that keeps
   * its own size (`controls="fit"`): a `fit` table draws cards unless a control fills its cell.
   * Returns the function that withdraws the registration.
   */
  registerControls?: (fill?: boolean) => () => void;
  /** True while the table draws its rows as cards (a stacked `fit` table). Cells read it. */
  readonly stackCard?: boolean;
  /** True for a `fit` table. Its row header holds to two lines, stacked or not. */
  readonly fit?: boolean;
  /**
   * Called by a header cell with its column position and `sizing`, and again with `undefined` when
   * it leaves that position; `owner` identifies the cell, so it withdraws only its own entry. Body
   * cells in the same column read it with `columnSizing`.
   */
  setColumnSizing?: (column: number, sizing: TableColumnSizing | undefined, owner: object) => void;
  /** The `sizing` a header cell declared for the column at `column`, if any. */
  columnSizing?: (column: number) => TableColumnSizing | undefined;
};

/**
 * How a column of a `fit` table takes its width: `'content'` is as wide as its widest value and
 * never wraps (a status word, a badge, an identifier, a count); `'fill'` takes the width the content
 * columns leave and wraps (prose).
 */
export type TableColumnSizing = 'content' | 'fill';

/**
 * Provided by TableRow: each Cinder cell in the row claims the next column position as it is
 * created. @internal
 */
export type TableRowColumnsContext = {
  /** Claims the next column position, `span` columns wide (a cell's `colspan`). */
  claimColumn: (span?: number) => number;
  /** Changes whenever the row's cells are added, removed or moved, so cells re-read their place. */
  readonly version: number;
};
/** Attributes forwarded to Table's generated scroll wrapper. */
export type TableScrollContainerProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'class'
> & {
  /** Additional class names merged with `.cinder-table-scroll`. */
  class?: string;
};
/**
 * Props for the Table component.
 *
 * Cinder's Table is **deliberately small**: semantic markup, controlled sort
 * state, optional sticky header, optional density, optional row selection.
 * It does NOT virtualize, sort, paginate, edit cells, pin columns, resize
 * columns, or aggregate. The consumer owns data ordering and dispatches sort
 * intents through the `sort` bindable.
 */
export type TableProps = Omit<HTMLTableAttributes, 'class'> & {
  /**
   * Bound sort state. When the user activates a sortable header, this prop
   * is updated to reflect the new column / direction.
   *
   * Pass `undefined` initially when no column is sorted; the component will
   * never write back `undefined` itself (sort always toggles to a column).
   */
  sort?: TableSort | undefined;
  /**
   * Accessible caption rendered as a `<caption>` element. It names the table for
   * assistive technology but is visually hidden: the heading above the table
   * already says what it is, and the table draws no title row of its own.
   */
  caption?: string;
  /** When true, the header sticks to the top of the scrolling container. @default false */
  stickyHeader?: boolean;
  /**
   * Vertical padding density for header and body cells.
   * Defaults to `'comfortable'`.
   * @default "comfortable"
   */
  density?: TableDensity;
  /**
   * Enables the leading selection column on the entire table. When true:
   * - The single `TableRow` inside `TableHeader` renders a leading `<th>`
   *   with a select-all checkbox sourced from the header's props.
   * - Every `TableRow` inside `TableBody` renders a leading selection cell.
   * Selection is strictly controlled — the consumer owns all selection state.
   * @default false
   */
  selectable?: boolean;
  /**
   * Wraps the table in a `.cinder-table-scroll` box that owns the frame (the border, the radius and
   * the clip) and scrolls sideways when the columns do not fit, with a visible scrollbar and a fade
   * at the inline end. The page never scrolls sideways. Pass `false` for a table that must lay out
   * as a bare `<table>`.
   *
   * When combined with `stickyHeader`, the generated wrapper is the sticky
   * header's scroll container. Set a bounded block size on `scrollContainerProps`
   * when the table should scroll vertically inside that wrapper.
   * @default true
   */
  scrollable?: boolean;
  /**
   * Draw no outline, radius or fill around the table, for a queue or list that sits on the page.
   * Rows keep their hairlines. @default false
   */
  frameless?: boolean;
  /**
   * Keeps the table's own frame inside a Card. Inside a Card a table is frameless by default (the
   * card is the frame; a box inside a box reads as clutter); set this to draw the frame anyway. It
   * changes nothing for a table outside a Card. @default false
   */
  framed?: boolean;
  /**
   * Fits the table to its container's width so a long value never makes it scroll sideways. The
   * columns share the width equally (a fixed table layout) unless a header cell sets `sizing`: a
   * `sizing="content"` column (a status word, a badge, an identifier, a count) is as wide as its
   * widest value, at most half the table, and does not wrap, and a `sizing="fill"` column (prose)
   * takes the width the content columns leave. A `truncate` cell ends its text with an ellipsis at
   * its column's width with the full text in a tooltip, and any other cell wraps its text. Leave it
   * off for a table whose columns should keep their natural widths and scroll when they do not fit.
   *
   * A `fit` table also stacks below `stackBelow`, as a list of flat rows: the `as="th"` cell (or the
   * first cell with text) is the title, a cell with `stack="end"` sits at its inline end, a cell
   * with `stack="status"` starts the second line, and every other cell is a line of its column's
   * header text and its value. A table with a `controls` cell that fills its cell keeps the control
   * layout instead.
   * @default false
   */
  fit?: boolean;
  /**
   * Attributes forwarded to the generated `.cinder-table-scroll` wrapper when
   * `scrollable` is true. The wrapper is focusable by default so keyboard users
   * can scroll read-only wide tables. When the table has a caption, or when
   * `aria-label` or `aria-labelledby` is provided here, the wrapper becomes a
   * named `region`; pass `role` or `tabindex` here to override those defaults.
   */
  scrollContainerProps?: TableScrollContainerProps;
  /**
   * Width of the table's own container below which a table whose cells hold controls, or a `fit`
   * table, stacks. With controls, each body row becomes a card: the name and its muted detail on
   * the first line, the controls full width at 44px beneath. A `fit` table stacks into flat rows
   * (see `fit`). A table that is neither `fit` nor holds a `controls` cell never stacks; it
   * scrolls. The width
   * is the container's (the scroll box, or the parent when `scrollable` is false), not the
   * window's, so a table in a narrow column stacks in a wide window. A simple CSS length such as
   * `'640px'`; only `px`, `rem` and `em` are measured against the container, and any other unit
   * falls back to the viewport. `false` keeps the table layout at every width. A `fit` table that
   * stacks as flat rows (no cell holds a control that fills it) stacks only below `'26rem'`
   * (416px) by default, because flat rows read well in a narrow column; the control layout keeps
   * 640px.
   * @default "640px"
   */
  stackBelow?: string | false;
  /** Additional class names merged with `.cinder-table`. */
  class?: string;
  /** TableHeader, TableBody, etc. */
  children: Snippet;
};
