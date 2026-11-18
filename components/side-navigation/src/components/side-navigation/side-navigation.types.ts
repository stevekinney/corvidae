import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
/** Props for the SideNavigation component. */
export type SideNavigationProps = Omit<
  HTMLAttributes<HTMLElement>,
  'aria-label' | 'aria-labelledby'
> & {
  /** Accessible name for the <nav> landmark. Required, non-empty, distinct from other navs on the page. */
  ariaLabel: string;
  /** Additional CSS class merged with `.cinder-side-navigation`. */
  class?: string;
  /**
   * The product's name, mark or workspace switcher, drawn above the primary action and the list.
   * Wrap it as you like; the slot adds only the padding that aligns it with the rows.
   */
  brand?: Snippet | undefined;
  /**
   * The one action the product leads with ("Capture", "New chat"), drawn under `brand` and above
   * the list. Render a single `<a>` or `<button>`: it is drawn as a neutral, sidebar-wide control
   * with a leading accent "+", its label, and, for an element with `data-cinder-shortcut`, the
   * shortcut glyph at the trailing edge as plain text with no key cap. It is never a full-width
   * accent slab. Name the shortcut for assistive technology with `aria-keyshortcuts` on the
   * control, and mark the glyph `aria-hidden`.
   */
  primaryAction?: Snippet | undefined;
  /** Must be <li> elements containing NavigationItem and/or SideNavigationGroup. */
  children: Snippet;
};

/** Schema generator surface for SideNavigation — excludes native attributes except supported styling hooks. */
export interface SideNavigationSchemaProps {
  /** Accessible name for the <nav> landmark. Required, non-empty, distinct from other navs on the page. */
  ariaLabel: string;
  /** Additional CSS class merged with `.cinder-side-navigation`. */
  class?: string;
  /** Inline style string applied to the `.cinder-side-navigation` root. */
  style?: string;
  /**
   * The product's name, mark or workspace switcher, drawn above the primary action and the list.
   * Wrap it as you like; the slot adds only the padding that aligns it with the rows.
   */
  brand?: Snippet;
  /**
   * The one action the product leads with ("Capture", "New chat"), drawn under `brand` and above
   * the list. Render a single `<a>` or `<button>`: it is drawn as a neutral, sidebar-wide control
   * with a leading accent "+", its label, and, for an element with `data-cinder-shortcut`, the
   * shortcut glyph at the trailing edge as plain text with no key cap. It is never a full-width
   * accent slab. Name the shortcut for assistive technology with `aria-keyshortcuts` on the
   * control, and mark the glyph `aria-hidden`.
   */
  primaryAction?: Snippet;
  /** Must be <li> elements containing NavigationItem and/or SideNavigationGroup. */
  children: Snippet;
}
