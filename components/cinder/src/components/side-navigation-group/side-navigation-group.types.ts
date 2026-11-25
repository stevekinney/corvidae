import type { Snippet } from 'svelte';
import type { HTMLLiAttributes } from 'svelte/elements';
/** Props for the SideNavigationGroup component. */
export type SideNavigationGroupProps = Omit<HTMLLiAttributes, 'id' | 'class'> & {
  /** The section's name: its visible header, or with `labelVisibility: 'hidden'` the list's accessible name. */
  label: string;
  /** Optional stable id for the root <li>. Trigger uses `${id}-trigger`, panel uses `${id}-panel`. If omitted, generated via useId. */
  id?: string;
  /**
   * Whether the group opens and closes. Default: true. Set `false` for a static section: its label
   * is plain text over an always-visible list, and in a collapsed sidebar the label gives way to
   * a hairline between sections. `expanded` and `disabled` do nothing on a static group.
   */
  collapsible?: boolean;
  /**
   * Whether a static group draws its label. Default: `'visible'`. `'hidden'` renders no header at
   * all: the label becomes the list's `aria-label`, so a screen reader still hears the section's
   * name, and sighted users see the sections apart by one gap. It does nothing on a collapsible
   * group, whose trigger is its label.
   */
  labelVisibility?: 'visible' | 'hidden';
  /** Whether the group is expanded. Bindable. Default: true. */
  expanded?: boolean;
  /** When true, the disclosure button is disabled. Default: false. */
  disabled?: boolean;
  /**
   * One reason that covers the group's disabled rows ("Choose a connection first"), drawn once
   * between the group's header and its rows, in the disabled colour at the extra-small size, and
   * the description of every disabled row in the group. A row draws its own `disabledReason` only
   * when it says something different; a row that repeats the group's reason draws nothing. It is
   * hidden with the rows while the group is collapsed, and clipped in a collapsed icon rail, where
   * it stays the rows' description.
   */
  disabledReason?: string;
  /** Optional leading icon rendered inside the header button before the label. */
  icon?: Snippet;
  /** Optional trailing badge rendered inside the header button after the label, before the chevron. */
  badge?: Snippet;
  /** Additional CSS class merged with `.cinder-side-navigation-group`. */
  class?: string;
  /** Must be <li>-wrapped NavigationItems (or SideNavigationItems) rendered inside the disclosed <ul>. */
  children: Snippet;
};
