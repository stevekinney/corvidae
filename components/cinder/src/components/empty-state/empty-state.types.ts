import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Alignment of an empty state's content: centred in the region, or at the inline start. */
export type EmptyStateAlign = 'center' | 'start';

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Primary heading text rendered as a heading element at the configured `headingLevel`. */
  title: string;
  /** Secondary descriptive text rendered as a paragraph below the title. */
  description?: string;
  /** Additional class merged onto the `.cinder-empty-state` root element. */
  class?: string;
  /**
   * Heading level for the title element.
   * @default 3
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Alignment of the content. `'center'` centres the icon, text, and action in
   * the region; `'start'` aligns them to the inline start, for a state that
   * reads as instructions rather than a placeholder.
   * @default 'center'
   */
  align?: EmptyStateAlign;
  icon?: Snippet;
  action?: Snippet;
};
