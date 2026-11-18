import { createLabelFit } from '@lostgradient/foundation/utilities/fit-label-to-row.ts';

/** The attribute that turns the "Add note" button into its icon-only form. */
export const NOTE_COMPACT_ATTRIBUTE = 'data-cinder-note-compact';

/**
 * Attached to the card's action row. The note button shows its words while the whole row fits on
 * one line with them, and only when it cannot does it fall back to its icon, which keeps its name
 * and its tooltip. The arming hint is meant to take a line of its own and is not an item of the row.
 */
export const fitNoteLabel = createLabelFit({
  control: '.cinder-approval-card__note-toggle',
  attribute: NOTE_COMPACT_ATTRIBUTE,
  ignore: '.cinder-inline-confirm__two-press-hint',
});
