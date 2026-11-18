import type { Snippet } from 'svelte';
import type { ChoiceGridItemState } from '../choice-grid/choice-grid.types.ts';

export type { ChoiceGridItemState };

/**
 * Props for the `<ChoiceGridItem>` leaf component.
 */
export type ChoiceGridItemProps = {
  /**
   * The value this item represents. Used as the key for selection state,
   * roving tabindex registration, and ARIA attributes.
   */
  value: string;

  /**
   * Feedback state for assessment / quiz usage. Defaults to `'neutral'`.
   * Layout dimensions do NOT change across states (stable cell sizing guarantee).
   */
  state?: ChoiceGridItemState;

  /** When true this item cannot be selected or focused. */
  disabled?: boolean;

  /**
   * One sentence under the title that says what choosing this does. Drawn only when the grid is
   * `variant="card"`, and linked to the item with `aria-describedby`.
   */
  description?: string;

  /**
   * A small icon drawn before the title. Drawn only when the grid is `variant="card"`; it is
   * decorative, so the title still names the choice.
   */
  icon?: Snippet;

  /** Additional class names merged with `.cinder-choice-grid-item`. */
  class?: string;

  /** Item content — label text, or richer markup. In a card grid this is the title. */
  children: Snippet;
};
