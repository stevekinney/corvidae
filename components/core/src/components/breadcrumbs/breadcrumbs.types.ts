import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/**
 * One breadcrumb entry. The current page entry omits `href` so it renders
 * as plain text with `aria-current="page"`.
 */
export type BreadcrumbItem = {
  /** Visible label for the entry. */
  label: string;
  /** Link target. Omit for the current page (last entry). */
  href?: string;
  /**
   * Makes the current page entry (the last one) a button that opens a popover, drawn with a
   * border and a chevron, truncating its label with an ellipsis at 300px. `true` fills the popover with the full label, which is what a long title needs; a
   * snippet fills it with anything else, such as the title and its actions. Ignored on every
   * entry but the last.
   */
  popover?: Snippet | true;
};

export type BreadcrumbsProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
  /** Ordered list of breadcrumb entries from root to current page. */
  items: BreadcrumbItem[];
  /** Custom separator between entries. Defaults to "/". */
  separator?: Snippet | string;
  /** Accessible name for the nav landmark. Defaults to "Breadcrumb". */
  label?: string;
  /**
   * Viewport width below which the trail collapses to its phone form: a back link labelled with
   * the parent ("Runs") followed by the current page, which truncates first. A trail with a
   * single entry shows just that entry. A simple CSS length such as `'640px'`, or `false` to
   * always show the whole trail. Default `'640px'`.
   */
  collapseBelow?: string | false;
  /**
   * Accessible name of the phone back link; `{label}` is replaced by the parent's label.
   * Default `"Back to {label}"`.
   */
  backLabel?: string;
  /**
   * How many ancestors (every entry before the current page) show before the rest fold into a
   * leading "…" button that lists them in a menu. Left unset, a trail shows every ancestor until
   * its container is narrower than 24rem, where one ancestor shows (the current page's parent):
   * an ancestor that cannot show its full first word is left out with its separator, never
   * squeezed to a fragment. A number applies at every width, and `0` folds every ancestor.
   */
  maxVisible?: number;
  /**
   * Accessible name of the "…" button that opens the hidden ancestors. Default
   * `"Show earlier pages"`.
   */
  overflowLabel?: string;
  /**
   * Called when a link in the hidden-ancestors menu is clicked, with the entry it opens. Call
   * `event.preventDefault()` to open the page without a reload, as an application's router does.
   * The menu renders in a portal, outside the trail's own element, so a click handler on the
   * trail never sees these links.
   */
  onOverflowNavigate?: (item: BreadcrumbItem, event: MouseEvent) => void;
  /** Additional class names merged with `.cinder-breadcrumbs`. */
  class?: string;
};

/**
 * Cinder-specific props for the Breadcrumbs component, used by the schema generator.
 * Excludes non-JSON-schemable props such as snippet render functions and structured
 * item arrays that are documented by the component itself.
 */
export interface BreadcrumbsSchemaProps {
  /**
   * Custom string separator between entries.
   * @default "/"
   */
  separator?: string;
  /**
   * Accessible name for the nav landmark.
   * @default "Breadcrumb"
   */
  label?: string;
  /**
   * Viewport width below which the trail collapses to a back link and the current page. A simple
   * CSS length such as `'640px'`, or `false` to always show the whole trail.
   * @default "640px"
   */
  collapseBelow?: string | false;
  /**
   * Accessible name of the phone back link; `{label}` is replaced by the parent's label.
   * @default "Back to {label}"
   */
  backLabel?: string;
  /**
   * How many ancestors show before the rest fold into a "…" menu. Unset, every ancestor shows
   * until the container is narrower than 24rem, where one does.
   */
  maxVisible?: number;
  /**
   * Accessible name of the "…" button that opens the hidden ancestors.
   * @default "Show earlier pages"
   */
  overflowLabel?: string;
  /** Additional class names merged with `.cinder-breadcrumbs`. */
  class?: string;
}
