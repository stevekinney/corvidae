import type { Snippet } from 'svelte';
import type { DataAttributes, PadUnion } from '../../_internal/union-props.ts';
import type {
  NavigationItemButtonExtra,
  NavigationItemLinkExtra,
  NavigationItemSharedHtmlAttributes,
} from '../navigation-item/navigation-item.types.ts';
import type { StatusDotStatus } from '../status-dot/status-dot.types.ts';

/**
 * Props for the SideNavigationItem component.
 *
 * Forwards all NavigationItem props except `variant` — side navigation always renders the
 * vertical variant so consumers cannot accidentally introduce a tombstone (horizontal-radius)
 * focus ring inside a sidebar list.
 *
 * COR-239: this used to be `DistributiveOmit<NavigationItemProps, 'variant'> & {...}`, where the
 * distributive `T extends unknown ? Omit<T, K> : never` trick fanned the `Omit` across
 * `NavigationItemProps`'s own link/button arms so the href/button discriminant survived. Once
 * `NavigationItemProps` itself was restructured (see navigation-item.types.ts) to avoid TS2590,
 * it is a single `TSIntersectionType` at the top level rather than a naked union — the
 * distributive trick no longer has a union to distribute over, so it would silently collapse
 * back to a plain `Omit` and lose the href/button exclusivity the comment above used to warn
 * about. This file instead re-assembles the same shape directly from the pieces
 * navigation-item.types.ts now exports for this purpose, rather than post-processing the
 * already-combined `NavigationItemProps`.
 */
export type SideNavigationItemProps = NavigationItemSharedHtmlAttributes &
  DataAttributes &
  PadUnion<NavigationItemLinkExtra | NavigationItemButtonExtra> & {
    /** Marks this item as the currently active destination; emits `aria-current` and applies active visual styling. */
    active?: boolean;
    /** Prevents interaction: removes the item from the tab order, blocks clicks, and applies disabled visual styling. */
    disabled?: boolean;
    /**
     * The `aria-current` token emitted while `active` is true. Defaults to `'page'`,
     * which is correct for navigation bars and breadcrumb-adjacent links. Use
     * `'true'` (or another standard token such as `'step'` / `'location'`) for
     * section/view switchers, where `'page'` would mislabel the current section as
     * the current page in the browsing context.
     */
    current?: 'page' | 'step' | 'location' | 'date' | 'time' | 'true';
    /** Additional class merged onto the `.cinder-navigation-item` root element. */
    class?: string;
    /**
     * The row's label, rendered after `icon`. When `icon` is also given, a collapsed row (an icon
     * rail) hides this label visually and keeps it in the accessible name.
     */
    children: Snippet;
    /**
     * The row's icon. Giving it lets the row collapse to an icon rail: the icon stays, the label
     * stays in the accessible name, and the count or dot moves onto the icon's corner. The wrapper
     * is `aria-hidden`, so the icon is decoration and the label names the row.
     */
    icon?: Snippet;
    /**
     * The row's name as plain text ("Health", "Reviews"). It names the row when a count is
     * present ("Health, 3 need attention") and is the first part of the tooltip
     * ("Reviews, 2 need you"). Without it the row has no composed name and no tooltip.
     */
    label?: string;
    /**
     * A count of things that want attention. Zero, a negative number and `undefined` show nothing.
     * Shown as plain, muted, right-aligned text at the trailing edge of the row (never a badge), or
     * as a small dot on the icon when collapsed, unless `dot` is set; always part of the
     * accessible name when `label` is given.
     */
    count?: number;
    /**
     * The words that follow the count in the accessible name and tooltip: "need you" gives
     * "Reviews, 2 need you". The count's own name is the number plus these words.
     */
    countLabel?: string;
    /**
     * The words that follow the label in the accessible name and tooltip when `count` is zero or
     * absent: "nothing needs attention" gives "Health, nothing needs attention". Without it a row
     * with no count is named by its label alone.
     */
    emptyLabel?: string;
    /**
     * A status dot shown beside the label (or on the icon when collapsed) in place of the numeric
     * count, for a row whose state is a signal and not a figure. The dot is hidden from assistive
     * technology, so a row that sets it should also set `count` and `countLabel`, which carry
     * the meaning in the accessible name.
     */
    dot?: StatusDotStatus;
    /**
     * Whether the row is drawn as an icon-rail entry. Defaults to the enclosing `Sidebar`'s collapsed
     * state, so a row follows its sidebar without being told.
     */
    collapsed?: boolean;
    /** Class merged onto the outer <li>. */
    listItemClass?: string;
  };
