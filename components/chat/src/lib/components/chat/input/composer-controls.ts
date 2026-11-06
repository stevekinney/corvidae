/**
 * What the composer tells the host's controls snippet: whether the row is too narrow for them.
 *
 * The composer's footer is one row that never wraps: attach, the host's controls, the meter, Send.
 * When the composer itself is narrower than {@link COMPOSER_FOLD_WIDTH} (a side panel docked
 * beside the conversation, a phone), the host folds several controls into one, such as Model,
 * Effort and Permissions into a single Settings menu.
 */
export interface ChatComposerControlsContext {
  /** Whether the composer is narrower than {@link COMPOSER_FOLD_WIDTH}, so the controls should fold. */
  readonly folded: boolean;
}

/**
 * The composer width in `rem` below which {@link ChatComposerControlsContext.folded} is `true`. The
 * full row (attach, Model, Effort, Permissions, the context meter and Send) needs about 38rem, so
 * the fold begins a little above that and the row never wraps or clips.
 */
export const COMPOSER_FOLD_WIDTH = 40;
