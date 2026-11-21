import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

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

/** One button of an empty state's `actions`. */
export type EmptyStateAction = {
  /** The button's words, such as "New goal". Use the verb the page header's create action uses. */
  label: string;
  /** Opens this address: the button is drawn as a link that looks like a button. */
  href?: string;
  /**
   * Opens `href` in a new tab, for an address outside the application such as a guide.
   * @default false
   */
  external?: boolean;
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

/**
 * An empty state has one layout wherever it sits, a page, a tab, a section or a panel (owner
 * report, 2026-11-19): the disc, the title, the sentence and the buttons stacked and centred
 * across, top-aligned at one offset rather than centred in the height, never in a box, with the
 * words held to a measure of about 60 characters. There is no size, alignment, border or row
 * variant for a caller to pick; a section that is empty shows the state alone, with no heading
 * above it saying the same thing.
 */
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
   * Why the view is empty. It sets the disc tint and the default glyph (first use, filtered, done, blocked, not found or disabled).
   * Every kind renders its `actions`; `'filtered'` also adds a secondary "Clear filters" button
   * before them when `onClearFilters` is set. Give `'first-use'` a primary button, `'done'` a
   * secondary one, and `'filtered'` the Clear filters button alone.
   * @default 'first-use'
   */
  kind?: EmptyStateKind;
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
   * A larger picture drawn above the title in place of the disc, for a state that wants more than
   * a glyph. Decorative, so it is hidden from assistive technology; say what is missing in the
   * title.
   */
  illustration?: Snippet;
  /**
   * Call-to-action content rendered after the `actions` buttons and the "Clear filters" button.
   * Prefer `actions`, which are always drawn as buttons; whatever goes here should be a `Button`
   * too, never a text link.
   */
  action?: Snippet;
  /**
   * Supporting content under the buttons, such as the steps of a manual set-up; the action stays
   * buttons. It holds the same measure as the words and draws no border or background.
   */
  children?: Snippet;
};
