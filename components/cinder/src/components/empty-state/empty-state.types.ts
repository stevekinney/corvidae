import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Alignment of an empty state's content: centred in the region, or at the inline start. */
export type EmptyStateAlign = 'center' | 'start';

/**
 * Why a view is empty: `'first-use'` nothing has been created yet, `'filtered'` a filter or
 * search hid everything that exists, and `'done'` the work is finished and nothing is left.
 */
export type EmptyStateKind = 'first-use' | 'filtered' | 'done';

/** Scale of an empty state: `'default'` fills a page region, `'compact'` fits a tab or panel. */
export type EmptyStateSize = 'default' | 'compact';

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
  /**
   * Why the view is empty. `'first-use'` shows the `action` snippet, `'filtered'` adds a
   * "Clear filters" button when `onClearFilters` is set, and `'done'` shows no action at all,
   * even when `action` is passed, because there is nothing left to do.
   * @default 'first-use'
   */
  kind?: EmptyStateKind;
  /**
   * Scale of the state. `'compact'` tightens the padding, disc, and type so the state fits a
   * tab or a panel rather than a whole page region.
   * @default 'default'
   */
  size?: EmptyStateSize;
  /** Called when the "Clear filters" button of a `'filtered'` state is pressed. The button renders only when this is set. */
  onClearFilters?: () => void;
  /**
   * Label of the "Clear filters" button.
   * @default 'Clear filters'
   */
  clearFiltersLabel?: string;
  /** Icon rendered above the title, centred in a tinted disc. Decorative, so it is hidden from assistive technology. */
  icon?: Snippet;
  /** Call-to-action content rendered below the description, after the "Clear filters" button when both exist. */
  action?: Snippet;
};
