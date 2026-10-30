/**
 * Shape of a multi-line skeleton group: `'row'` stacks `lines` bars on the surrounding surface,
 * and `'card'` draws them inside a bordered card beneath a heading bar.
 */
export type SkeletonVariant = 'row' | 'card';

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
   * `lines` bars in a bordered card.
   * @default 'row'
   */
  variant?: SkeletonVariant;
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
   * Text of the "Still loading" status.
   * @default 'Still loading…'
   */
  stillLoadingLabel?: string;
  /**
   * Label of the Cancel button in the "Still loading" status.
   * @default 'Cancel'
   */
  cancelLabel?: string;
};
