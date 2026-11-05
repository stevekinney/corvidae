/**
 * Shape of a multi-line skeleton group: `'row'` stacks `lines` bars on the surrounding surface,
 * `'card'` draws them inside a bordered card beneath a heading bar, and `'list'` draws `rows`
 * rows of a status-first list (a status column, two text bars and a time bar) in a bordered
 * surface, the shape of a list of stacked list items.
 */
export type SkeletonVariant = 'row' | 'card' | 'list';

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
   * `lines` bars in a bordered card; `'list'` draws `rows` status-first list rows.
   * @default 'row'
   */
  variant?: SkeletonVariant;
  /**
   * Number of list rows to draw when `variant` is `'list'`. Each row keeps the 8rem status
   * column reserved, then shows two text bars and a time bar, with no leading circle, so
   * nothing shifts when data arrives. Clamped to between 1 and 20. Ignored by other variants.
   * @default 3
   */
  rows?: number;
  /**
   * What fills the status column of each row when `variant` is `'list'`. `'bar'` is a short bar
   * where the status word reads; `'dot'` is a small circle where the status dot sits. The column
   * keeps its width either way, so nothing shifts when data arrives. Ignored by other variants.
   * @default 'bar'
   */
  statusMarker?: SkeletonStatusMarker;
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
};
