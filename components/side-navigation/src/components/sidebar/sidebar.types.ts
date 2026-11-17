import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
/** Props for the Sidebar component. */
export type SidebarProps = Omit<
  HTMLAttributes<HTMLElement>,
  'aria-label' | 'aria-labelledby' | 'class' | 'children'
> & {
  /**
   * Whether the sidebar is collapsed. Bindable via `bind:collapsed`. Default `false`.
   *
   * Above `mobileBreakpoint`, `collapsed=true` switches the sidebar to
   * icon-only mode. At or below `mobileBreakpoint`, the sidebar renders inside a
   * `<Drawer>` and `collapsed=true` means the drawer is closed.
   */
  collapsed?: boolean;
  /**
   * Accessible name for the outer landmark and the mobile drawer. Defaults to
   * `'Sidebar'` for convenience but must be unique per page. Navigation content
   * owns its own accessible name; for example, use `SideNavigation.ariaLabel`.
   */
  label?: string;
  /**
   * Viewport width below which the sidebar switches from the inline aside to
   * the mobile drawer. Accepts a simple CSS length such as `'639.98px'` or
   * `'1024px'`. Default `'639.98px'`, so tablets keep the inline column and
   * its icon rail.
   */
  mobileBreakpoint?: string;
  /**
   * When the sidebar is collapsed above `mobileBreakpoint`, draws it as a 76px rail with a short
   * label under every icon instead of the 56px icon-only column whose labels are clipped. The
   * labels are drawn, so the rail needs no tooltip and a touch screen needs no drawer. A row's
   * count or dot rides the icon's corner, and the brand and the primary action keep to their icon
   * or plus. Has no effect on an expanded sidebar or on the drawer. Default `false`.
   */
  railLabels?: boolean;
  /**
   * A parenthesized media query that also turns the sidebar into the drawer, beside the width
   * breakpoint, for a layout that depends on more than width: `'(pointer: coarse) and
   * (max-width: 1023.98px)'` gives touch devices the drawer at every width below 1024, because an
   * icon rail with tooltip-only labels has no labels on touch. Read after the page loads; the
   * server markup is the inline column.
   */
  drawerQuery?: string;
  /**
   * Accessible name of the drawer's close button. Default `'Close navigation'`.
   */
  closeLabel?: string;
  /** Additional CSS class merged with `.cinder-sidebar`. */
  class?: string;
  /**
   * Navigation content. Typically a `<SideNavigation>` subtree, which owns the
   * navigation landmark and its accessible name. Optional so the sidebar can
   * serve as app chrome without a navigation list.
   */
  navigation?: Snippet;
  /** Optional footer region (e.g. user account, sign-out). */
  footer?: Snippet;
};
