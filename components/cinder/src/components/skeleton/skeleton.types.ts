import type { Snippet } from 'svelte';

/**
 * Shape of a multi-line skeleton group: `'row'` stacks `lines` bars on the surrounding surface,
 * `'card'` draws them inside a bordered card beneath a heading bar, and `'list'` draws `rows`
 * rows of a status-first list (a status column, two text bars and a time bar) in a bordered
 * surface, the shape of a list of stacked list items, `'grouped'` draws `rows` rows of a grouped
 * list (two text bars, and a button block when `action` is set) on the one rounded surface a
 * grouped list draws, and `'form'` draws `rows` fields, each a short label bar above a full-width
 * control bar, the shape of a form that is still loading.
 */
export type SkeletonVariant = 'row' | 'card' | 'list' | 'grouped' | 'form';

/**
 * What stands in for a list row's status in the reserved status column: a short `'bar'` for a
 * status word ("Running"), or a small `'dot'` for a list whose rows lead with a status dot.
 */
export type SkeletonStatusMarker = 'bar' | 'dot';

/** Props for the Skeleton component. */
export type SkeletonProps = {
  /** CSS width value applied as an inline style on the skeleton block (e.g. `'200px'`, `'100%'`). */
  width?: string;
  /** CSS height value applied as an inline style on the skeleton block (e.g. `'1rem'`, `'48px'`). */
  height?: string;
  /** CSS border-radius value applied as an inline style, overriding the default pill shape (e.g. `'4px'`, `'50%'`). */
  radius?: string;
  /** Additional class merged onto the root element: `.cinder-skeleton` for a single block, or `.cinder-skeleton-group` when `lines`, `variant`, or `stillLoadingAfter` render a group. */
  class?: string;
  /**
   * Number of text bars to stack. More than one renders a group, and the last bar is shorter
   * unless `width` is set. Clamped to between 1 and 20.
   * @default 1
   */
  lines?: number;
  /**
   * Shape of the group. `'row'` stacks the bars directly; `'card'` wraps a heading bar and the
   * `lines` bars in a bordered card; `'list'` draws `rows` status-first list rows; `'grouped'`
   * draws `rows` grouped-list rows; `'form'` draws `rows` fields, a label bar over a control bar
   * each.
   * @default 'row'
   */
  variant?: SkeletonVariant;
  /**
   * Number of fields to draw when `variant` is `'form'`, of list rows when it is `'list'`, and of
   * grouped-list rows when it is `'grouped'`. A list row keeps the 8rem status
   * column reserved, then shows two text bars and a time bar, with no leading circle, so
   * nothing shifts when data arrives. Clamped to between 1 and 20. Ignored by other variants.
   * @default 3
   */
  rows?: number;
  /**
   * Draw a block the size of a small button at the end of each row when `variant` is `'grouped'`,
   * for a grouped list whose rows end in text actions. On a phone (below 640px) the block drops
   * under the text at full width, where the real buttons go. Ignored by other variants.
   * @default false
   */
  action?: boolean;
  /**
   * What fills the status column of each row when `variant` is `'list'`. `'bar'` is a short bar
   * where the status word reads; `'dot'` is a small circle where the status dot sits. The column
   * keeps its width either way, so nothing shifts when data arrives. Ignored by other variants.
   * @default 'bar'
   */
  statusMarker?: SkeletonStatusMarker;
  /**
   * Keep the 8rem status column that every status-first list shares when `variant` is `'list'`.
   * Turn it off for a list whose rows do not lead with a status word, such as a card of problems
   * with a glyph and an action: the marker then sits right before the text, so the placeholder
   * matches the row it stands for. Ignored by other variants.
   * @default true
   */
  statusColumn?: boolean;
  /**
   * Draw the list's own border and rounded corners when `variant` is `'list'`. Turn it off inside
   * a card that already frames its rows, so the placeholder does not draw a box within the box.
   * Ignored by other variants.
   * @default true
   */
  framed?: boolean;
  /**
   * Draw a day band (a tinted header with one bar) above the rows when `variant` is `'list'`,
   * the placeholder for a list that groups its rows by day. Ignored by other variants.
   * @default false
   */
  dayBand?: boolean;
  /**
   * Accessible name of the loading region, announced politely once the placeholder appears
   * (for example `'Loading agents'`). The placeholder bars stay hidden from assistive
   * technology and no spinner is drawn. Applies to the grouped variants; omit it when the
   * surrounding region already says what is loading.
   */
  label?: string;
  /**
   * Milliseconds to wait after mounting before anything renders. A load that finishes inside
   * the delay never flashes a placeholder. Use `300` for the Cinder loading rule.
   * @default 0
   */
  delay?: number;
  /**
   * Milliseconds after mounting at which a "Still loading" status replaces silence, with a
   * Cancel button when `onCancel` is set. Counted from mount, not from the end of `delay`.
   * Use `10000` for the Cinder loading rule. Omit to never show the status.
   */
  stillLoadingAfter?: number;
  /** Called when the Cancel button in the "Still loading" status is pressed. The button renders only when this is set. */
  onCancel?: () => void;
  /**
   * Text of the "Still loading" status. Pages replace the default with their own noun, for
   * example `'Still loading runs. This is taking longer than usual.'`.
   * @default 'Still loading. This is taking longer than usual.'
   */
  stillLoadingLabel?: string;
  /**
   * Label of the Cancel button in the "Still loading" status.
   * @default 'Cancel'
   */
  cancelLabel?: string;
  /**
   * The page's own placeholder, drawn instead of the bars, for a loading state whose shape is a
   * whole page (real labels and headings with placeholder values and rows). The group still owns
   * the timing: nothing is drawn until `delay` has passed, and the "Still loading" status follows
   * the content after `stillLoadingAfter`. The group is marked busy while it shows. Draw each
   * placeholder block with a `Skeleton` of its own; the content is not hidden from assistive
   * technology, so text in it is read as written.
   */
  children?: Snippet;
};
