import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Alignment of an empty state's content: centred in the region, or at the inline start. */
export type EmptyStateAlign = 'center' | 'start';

/**
 * Why a view is empty, which sets the tint of the disc and the glyph it shows when no `icon` is
 * passed:
 *
 * - `'first-use'`: nothing has been created yet. An accent disc; the view's own icon goes in it.
 * - `'filtered'`: a filter or search hid everything that exists. A neutral disc with a funnel.
 * - `'done'`: the work is finished and nothing is left. A green disc with a check.
 * - `'blocked'`: a condition the person can fix keeps the view from showing anything. An amber
 *   disc with a warning glyph.
 * - `'not-found'`: the thing asked for doesn't exist. A neutral disc with a magnifying glass.
 * - `'disabled'`: a setting the person chose (a disabled plugin) holds the content back, which is
 *   not a warning. A neutral disc with a plug.
 */
export type EmptyStateKind =
  'first-use' | 'filtered' | 'done' | 'blocked' | 'not-found' | 'disabled';

/** Scale of an empty state: `'default'` fills a page region, `'compact'` fits a tab or panel. */
export type EmptyStateSize = 'default' | 'compact';
/**
 * How an empty state is laid out: `'stacked'` centres the disc, title, description and action one
 * under the other in the region; `'row'` puts them on one line, the disc and the words at the
 * start and the action at the end, for a state that sits inside a card or list in place of its rows;
 * `'inline'` puts a 32px disc beside one line of text, the title in bold followed by the sentence,
 * at the inline start, for a state that sits among rows (the runs of a schedule below the Now marker).
 */
export type EmptyStateLayout = 'stacked' | 'row' | 'inline';

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
   * Why the view is empty. It sets the disc tint and the default glyph (first use, filtered, done, blocked, not found or disabled).
   * Every kind renders the `action` snippet; `'filtered'` also adds a secondary "Clear filters"
   * button before it when `onClearFilters` is set. Give `'first-use'` a primary button, `'done'`
   * a quiet `Link`, and `'filtered'` the Clear filters button alone.
   * @default 'first-use'
   */
  kind?: EmptyStateKind;
  /**
   * Scale of the state. `'compact'` tightens the padding, disc, and type so the state fits a
   * tab or a panel rather than a whole page region.
   * @default 'default'
   */
  size?: EmptyStateSize;
  /**
   * Whether the state stacks its parts and centres them (`'stacked'`), lays them on one row,
   * with the disc and the words at the start and the action at the end (`'row'`), or draws a 32px
   * disc beside the title and the sentence on one line (`'inline'`). A row reads as the line of a
   * list, such as "Nothing is waiting on you" with its link to the page that holds the rest, so it
   * is the layout for a state inside a card; on a phone its action drops under the words. Inline
   * sits among rows at the inline start, without the vertical padding of a region; use it with
   * `size="compact"`.
   * @default 'stacked'
   */
  layout?: EmptyStateLayout;
  /**
   * Draws the state inside a bordered, rounded box, for a list or page body that has no
   * container of its own. Leave it off when a card or panel already surrounds the state.
   * @default false
   */
  bordered?: boolean;
  /** Called when the "Clear filters" button of a `'filtered'` state is pressed. The button renders only when this is set. */
  onClearFilters?: () => void;
  /**
   * Label of the "Clear filters" button.
   * @default 'Clear filters'
   */
  clearFiltersLabel?: string;
  /**
   * Replaces the glyph in the disc. First use shows the view's own icon; every other kind has a
   * default glyph. Decorative, so it is hidden from assistive technology.
   */
  icon?: Snippet;
  /**
   * Call-to-action content rendered below the description, after the "Clear filters" button when
   * both exist. A primary `Button` for first use, a `Link` (accent, underlined only on hover) for
   * done, and a secondary button for a not-found or blocked state.
   */
  action?: Snippet;
};
