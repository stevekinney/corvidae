import type { Snippet } from 'svelte';
import type { HTMLThAttributes } from 'svelte/elements';

import type { TableColumnSizing } from '../table/table.types.ts';

// `aria-sort` is owned by the component (computed from the parent Table's sort state
// and emitted after the attribute spread), so it's Omit-ted — a consumer value would
// be silently dropped at runtime.
export type TableHeaderCellProps = Omit<
  HTMLThAttributes,
  'class' | 'align' | 'scope' | 'aria-sort'
> & {
  /**
   * Column key. Required when `sortable=true` so the parent Table can
   * track which column the user activated.
   */
  column?: string;
  /**
   * When true, render a button inside the `<th>` and dispatch sort intents
   * to the parent Table. The cell's `aria-sort` reflects the current sort
   * direction (`ascending`, `descending`, or `none`).
   * @default false
   */
  sortable?: boolean;
  /** When set, hint to assistive tech that the column groups multiple rows. @default "col" */
  scope?: 'col' | 'colgroup';
  /** Horizontal alignment for the header cell content. Defaults to `'left'`. @default "left" */
  align?: 'left' | 'center' | 'right';
  /**
   * How this column takes its width in a `fit` table. `'content'` is for a short value (a status
   * word, a badge, an identifier, a count): the column is as wide as its widest header or cell,
   * never wider than half the table (28rem for a table drawn with `scrollable={false}`, which has
   * no scroll box to measure), and its cells do not wrap; a longer value ends in an ellipsis
   * with the whole value in a tooltip. `'fill'` is for prose: the column takes the width the
   * `content` columns leave and wraps, its text running the full width of the column. Left out, a column shares the width
   * equally with the others, as every column of a `fit` table with no `sizing` does. It has no
   * effect outside a `fit` table, or while the table is stacked.
   */
  sizing?: TableColumnSizing;
  /**
   * The column's name as text, printed beside each value while the table is stacked. It is in the
   * server's HTML, so the first paint of a stacked table already carries every label. Usually the
   * header's own text; `''` for a column with no name (a selection column).
   */
  label?: string;
  /** Additional class names merged with `.cinder-table__header-cell`. */
  class?: string;
  /** Cell content (column label). */
  children: Snippet;
  /** Optional controls rendered beside, but outside, the sortable button. */
  actions?: Snippet;
};
