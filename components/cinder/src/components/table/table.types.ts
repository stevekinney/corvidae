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
   * Called by a cell that holds a control while it is mounted. The table stacks its rows only
   * while at least one cell is registered. Returns the function that withdraws the registration.
   */
  registerControls?: () => () => void;
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
   * Fits the table to its container's width so a long value never makes it scroll sideways. The
   * columns share the width (a fixed table layout: set a column's width on its header cell or a
   * `<col>`), a `truncate` cell ends its text with an ellipsis at its column's width with the full
   * text in the `title`, and any other cell wraps its text. Leave it off for a table whose columns
   * should keep their natural widths and scroll when they do not fit.
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
   * Width of the table's own container below which a table whose cells hold controls stacks. Each
   * body row becomes a card: the name and its muted detail on the first line, the controls full
   * width at 44px beneath. A table with no `controls` cell never stacks; it scrolls. The width
   * is the container's (the scroll box, or the parent when `scrollable` is false), not the
   * window's, so a table in a narrow column stacks in a wide window. A simple CSS length such as
   * `'640px'`; only `px`, `rem` and `em` are measured against the container, and any other unit
   * falls back to the viewport. `false` keeps the table layout at every width.
   * @default "640px"
   */
  stackBelow?: string | false;
  /** Additional class names merged with `.cinder-table`. */
  class?: string;
  /** TableHeader, TableBody, etc. */
  children: Snippet;
};
