import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { DataListGroup } from '../data-list/data-list.types.ts';
import type { TableDensity, TableSort } from '../table/table.types.ts';

/**
 * A generic record type representing a single data row.
 * Keys are strings; values may be anything renderable.
 */
export type DataTableRow = Record<string, unknown>;

/**
 * Column descriptor for a DataTable.
 *
 * @template Row - The row record type. Defaults to `DataTableRow`.
 */
export type DataTableColumn<Row extends DataTableRow = DataTableRow> = {
  /**
   * The key used to read the cell value from each row object.
   * Should be a key of `Row` when Row is a typed record.
   */
  key: keyof Row & string;
  /** Human-readable column label rendered in the `<th scope="col">` header cell. */
  label: string;
  /**
   * When true, the header cell renders a sort button and reports `aria-sort`.
   * Sort state is controlled by the consumer via the `sort` bindable — DataTable
   * never reorders rows itself.
   */
  sortable?: boolean;
  /**
   * Horizontal alignment for both the header and body cells of this column.
   * - `'start'` maps to left-aligned text (default).
   * - `'center'` maps to centered text.
   * - `'end'` maps to right-aligned text with `font-variant-numeric: tabular-nums`.
   */
  align?: 'start' | 'center' | 'end';
  /**
   * When true, the body cells in this column render as `<th scope="row">` instead
   * of `<td>`, identifying this column as the row-header for assistive technology.
   *
   * At most one column should set `rowHeader: true`. If no column sets it, the
   * first column automatically acts as the row header.
   */
  rowHeader?: boolean;
  /**
   * When true, the column's body cells keep their text on one line and end it
   * with an ellipsis, with the full text in the cell's `title`. One very long
   * value then cannot widen the table.
   */
  truncate?: boolean;
  /**
   * Marks the column's body cells as holding form controls (a select, a checkbox, a button), which
   * the `cell` snippet draws. The controls fill the cell and share one width; `'fit'` is for a
   * control that keeps its own size, such as a checkbox. A table with a controls column stacks on a
   * narrow container (see `stackBelow`).
   */
  controls?: boolean | 'fit';
  /**
   * When true, the column's body cells render in the monospace face, for identifiers, keys and
   * paths.
   */
  monospace?: boolean;
  /** The column's starting width in pixels, for a resizable table. */
  width?: number;
  /** The narrowest a resizable column can be dragged to, in pixels. */
  minWidth?: number;
  /**
   * The widest a resizable column can be dragged to, in pixels. For a `truncate` column it is also
   * the widest its text grows before it ends with an ellipsis, so one long value cannot take the
   * room the other columns need.
   */
  maxWidth?: number;
};

/** What the `cell` snippet receives for one body cell. */
export type DataTableCellContext<Row extends DataTableRow = DataTableRow> = {
  /** The row record. */
  row: Row;
  /** The column the cell belongs to. */
  column: DataTableColumn<Row>;
  /** The row's value for the column, `row[column.key]`. */
  value: unknown;
  /** The row's position in `rows`. */
  index: number;
};

/** What the `rowMessage` snippet receives for one row. */
export type DataTableRowContext<Row extends DataTableRow = DataTableRow> = {
  /** The row record. */
  row: Row;
  /** The row's position in `rows`. */
  index: number;
};

/** Row-selection mode for DataTable. */
export type DataTableSelectionMode = 'none' | 'single' | 'multiple';

/**
 * Props for the DataTable component.
 *
 * DataTable is a data-driven convenience wrapper over the compositional Table family.
 * It accepts an array of column descriptors and row records and renders the correct
 * semantic table markup automatically. For full compositional control, use Table,
 * Table.Header, Table.Body, Table.Row, Table.HeaderCell, and Table.Cell directly.
 *
 * @template Row - The row record type. Defaults to `DataTableRow`.
 */
export type DataTableProps<Row extends DataTableRow = DataTableRow> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class'
> & {
  /** Column descriptors defining the headers and cell rendering for each column. */
  columns: DataTableColumn<Row>[];
  /** Row data. Each entry is read via `column.key` for each column. */
  rows: Row[];
  /** Visual caption rendered as a `<caption>` element above the table. */
  caption?: string;
  /**
   * Bound sort state. When the user activates a sortable header cell, this prop
   * is updated with the new `{ column, direction }`. The consumer is responsible
   * for reordering `rows` in response — DataTable does not sort internally.
   *
   * Pass `undefined` initially when no column is sorted; the component will never
   * write back `undefined` itself (sort always toggles to a column).
   */
  sort?: TableSort | undefined;
  /**
   * Enables checkbox-based row selection. `"none"` renders no selection controls,
   * `"single"` allows one selected row id, and `"multiple"` allows any number.
   * Selection state is exposed through row checkbox controls; native table rows
   * do not emit `aria-selected`.
   * Defaults to `"none"`.
   */
  selectable?: DataTableSelectionMode;
  /**
   * Bound selected row ids. Arrays stay arrays on update; Sets stay Sets.
   * When omitted, DataTable starts with an empty array.
   */
  selectedRowIds?: string[] | Set<string>;
  /**
   * Resolves the stable row id used for selection. Defaults to `row.id` when it
   * is a string or number, otherwise the row's current positional index.
   */
  getRowId?: (row: Row, index: number) => string;
  /** Returns true when a row should render a disabled selection checkbox. */
  isRowSelectionDisabled?: (row: Row, index: number) => boolean;
  /** Accessible label for the multiple-selection header checkbox. */
  selectAllLabel?: string;
  /** Accessible label for an individual row selection checkbox. */
  rowSelectionLabel?: (row: Row, index: number) => string;
  /** When true, the header sticks to the top of the scrolling container. */
  stickyHeader?: boolean;
  /**
   * Vertical padding density for header and body cells.
   * Defaults to `'comfortable'`.
   */
  density?: TableDensity;
  /**
   * Draws the table inside the same scroll box a `Table` uses: it owns the border, the radius and
   * the clip, scrolls sideways when the columns do not fit, and fades at the inline end. A
   * virtualized table always scrolls in this box.
   * @default true
   */
  scrollable?: boolean;
  /**
   * Width of the table's own container below which a table with a `controls` column stacks, each
   * row becoming a card with the controls on a line of their own. See `Table`.
   * @default "640px"
   */
  stackBelow?: string | false;
  /**
   * Draws the content of every body cell, in place of the plain value, for cells that hold more
   * than text: a checkbox, a select, a name with its identifier beneath. Render
   * `{context.value}` for a column that needs nothing special.
   */
  cell?: Snippet<[context: DataTableCellContext<Row>]>;
  /**
   * Draws a message across the full width of the table directly under a row, such as the line
   * that says a save failed. It is a row of its own, not squeezed into a cell, and it belongs to
   * the row above it. Which rows have one is `hasRowMessage`. Give the message `role="alert"` when
   * it reports a failure, so it is announced.
   */
  rowMessage?: Snippet<[context: DataTableRowContext<Row>]>;
  /**
   * Whether a row has a message under it. Without it, every row has one while `rowMessage` is set.
   */
  hasRowMessage?: (row: Row, index: number) => boolean;
  /**
   * Groups consecutive rows under a header row that spans the table, such as a day. Each run of
   * rows with the same group key follows one header, drawn as the group's `label` and, after a dot,
   * its `detail` (the time zone). Rows are not reordered; pass them already sorted. Ignored while
   * `virtualized`.
   */
  groupBy?: (row: Row, index: number) => DataListGroup;
  /**
   * Content of a footer row that spans the table, below the last row: a count, a hint. The table
   * stays one framed box.
   */
  footer?: Snippet;
  /**
   * Called when the end of the table scrolls into view, and again after `rows` grows while the end
   * is still in view, so a table loads more rows by scrolling and needs no button. Pass it only
   * while there are more rows to load, and guard against a load already in flight.
   */
  onReachEnd?: (() => void) | undefined;
  /**
   * Id of the open row, the one a detail pane shows. It is marked `aria-current` and drawn
   * highlighted. Ids are the ones `getRowId` returns.
   */
  openRowId?: string | null;
  /**
   * Makes each row open on a click, Enter or Space, and gives the rows one tab stop with Arrow keys,
   * Home and End moving between them. A click on a control inside the row (a button, a link, a
   * field) does not open it.
   */
  onRowOpen?: (row: Row, index: number) => void;
  /** Enables pointer and keyboard resizing handles in column headers. */
  resizable?: boolean;
  /** Called after a column width changes through a pointer or keyboard resize handle. */
  onColumnResize?: (columnKey: string, width: number) => void;
  /**
   * When true, renders only the visible `<tbody>` row window plus spacer rows.
   * Requires a fixed row height. This is intended for large, append-only tables
   * such as live logs or event streams.
   */
  virtualized?: boolean;
  /**
   * Fixed body row height in pixels for virtualized mode.
   * This must match the actual rendered body row height, including density
   * padding and any wrapping introduced by the table content.
   * Defaults to 44.
   */
  rowHeight?: number;
  /**
   * Extra body rows rendered before and after the visible virtualized window.
   * Defaults to 5.
   */
  overscan?: number;
  /**
   * CSS block-size for the virtualized native scroll container.
   * Defaults to `"24rem"` when `virtualized` is true.
   */
  height?: string;
  /**
   * When true in virtualized mode, appending rows while scrolled to the bottom
   * keeps the newest row pinned in view. Appending while scrolled up does not
   * change the viewport.
   */
  stickToBottom?: boolean;
  /**
   * Additional class names merged onto DataTable's root wrapper element (the
   * `<div class="cinder-data-table">` that contains the table). To style the
   * `<table>` itself, target `.cinder-data-table table` from this class.
   */
  class?: string;
};
