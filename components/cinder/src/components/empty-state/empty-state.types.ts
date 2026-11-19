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
 * at the inline start, for a state that sits among rows (the runs of a schedule below the Now marker);
 * `'page'` is a list page's first use under its page header: stacked and centred across, but
 * top-aligned at one offset on every page, never in a box, with a measure of about 60 characters.
 */
export type EmptyStateLayout = 'stacked' | 'row' | 'inline' | 'page';

/** One button of an empty state's `actions`. */
export type EmptyStateAction = {
  /** The button's words, such as "New goal". Use the verb the page header's create action uses. */
  label: string;
  /** Opens this address: the button is drawn as a link that looks like a button. */
  href?: string;
  /** Called when the button is pressed. Not called while the button is inert. */
  onclick?: (event: MouseEvent) => void;
  /**
   * The button's emphasis. The first action is the primary one and every later one is secondary
   * unless this says otherwise.
   */
  variant?: 'primary' | 'secondary';
  /** A leading icon, such as the "+" of a create action. Decorative: the label names the action. */
  icon?: Snippet;
  /**
   * Makes the button inert and says why: it stays focusable, ignores the press, carries
   * `aria-disabled`, and the reason describes it.
   */
  inertReason?: string;
  /**
   * Whether the action changes something, so it goes inert under a stale `<StaleRegion>`.
   * @default false
   */
  mutating?: boolean;
};

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
   * `size="compact"`. `'page'` is a list page's first use under its page header: the parts stacked
   * and centred across, top-aligned at the same offset on every page, never bordered, at the default
   * size, with the title and the sentence held to about 60 characters; pass the page's own icon and
   * its `actions`.
   * @default 'stacked'
   */
  layout?: EmptyStateLayout;
  /**
   * Draws the state inside a bordered, rounded box, for a list or page body that has no
   * container of its own. Leave it off when a card or panel already surrounds the state. The
   * `'page'` layout is never boxed and ignores it.
   * @default false
   */
  bordered?: boolean;
  /**
   * The state's buttons, drawn by the component so they are always buttons, never text links: the
   * first is primary (the page's create action, with the header's verb) and any later one is
   * secondary. They come before the `action` snippet when both are passed.
   */
  actions?: readonly EmptyStateAction[];
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
   * A larger picture drawn above the title in place of the disc, for a page-sized state that wants
   * more than a glyph. Drawn only in the `'stacked'` layout; a `'row'` or `'inline'` state keeps its
   * disc and ignores it. Decorative, so it is hidden from assistive technology; say what is
   * missing in the title.
   */
  illustration?: Snippet;
  /**
   * Call-to-action content rendered below the description, after the "Clear filters" button when
   * both exist. A primary `Button` for first use, a `Link` (accent, underlined only on hover) for
   * done, and a secondary button for a not-found or blocked state.
   */
  action?: Snippet;
  /**
   * Supporting content under the call to action, such as the steps of a manual set-up; the action
   * stays buttons. It follows `align`, takes the full width of the state with no measure of its
   * own, and draws no border or background. Drawn only in the `'stacked'` layout; a `'row'` or
   * `'inline'` state ignores it.
   */
  children?: Snippet;
};
