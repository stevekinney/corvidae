/**
 * What the composer tells the host's controls snippet: whether the row is too narrow for them.
 *
 * The composer's footer is one row that never wraps: attach, the host's controls, the meter, Send.
 * When the composer itself is narrower than {@link COMPOSER_FOLD_WIDTH} (a side panel docked
 * beside the conversation, a phone), or the controls' values do not fit beside the meter and Send
 * in full at any width, the host folds several controls into one, such as Model, Effort and
 * Permissions into a single Settings menu, so no value is cut to a stub.
 */
export interface ChatComposerControlsContext {
  /**
   * Whether the controls should fold: the composer is narrower than {@link COMPOSER_FOLD_WIDTH}, or
   * the controls at their full width do not fit the room the footer leaves them.
   */
  readonly folded: boolean;
}

/**
 * The composer width in `rem` below which {@link ChatComposerControlsContext.folded} is always
 * `true`. The full row (attach, Model, Effort, Permissions, the context meter and Send) needs about
 * 38rem with short values, so the fold begins a little above that; above it the composer folds
 * only when the values it measures do not fit.
 */
export const COMPOSER_FOLD_WIDTH = 40;

/** What the composer measured of itself and its footer, in CSS pixels. */
export interface ComposerFoldMeasure {
  /** The composer's own width; `0` when it has no layout to measure. */
  readonly composerWidth: number;
  /** The root font size, which {@link COMPOSER_FOLD_WIDTH} is counted in. */
  readonly remInPixels: number;
  /** The room the footer leaves the attach button and the controls, beside the meter and Send. */
  readonly availableWidth: number;
  /**
   * The width the attach button and the controls take with every value in full, measured while they
   * were last drawn unfolded; `undefined` before they have been.
   */
  readonly neededWidth: number | undefined;
}

/**
 * Whether the composer's controls fold into one: below {@link COMPOSER_FOLD_WIDTH} always, and at
 * any width when the controls in full need more room than the footer leaves them. A composer with
 * no layout (`composerWidth` of `0`) draws the full row.
 */
export function composerControlsFold(measure: ComposerFoldMeasure): boolean {
  if (measure.composerWidth <= 0) return false;
  if (measure.composerWidth < COMPOSER_FOLD_WIDTH * measure.remInPixels) return true;
  if (measure.neededWidth === undefined) return false;
  // Half a pixel of rounding is not a stub.
  return measure.neededWidth > measure.availableWidth + 0.5;
}
