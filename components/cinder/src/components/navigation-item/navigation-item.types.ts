import type { Snippet } from 'svelte';

import type {
  FlatHTMLAnchorAttributes,
  FlatHTMLButtonAttributes,
} from '../../_internal/forwarded-html-attributes.generated.ts';
import type { WellKnownDataTestId } from '../../_internal/well-known-data-attributes.ts';

type CommonArm = WellKnownDataTestId & {
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
   * Controls item geometry. Emitted as `data-variant`. Default `'horizontal'`.
   *
   * - `'horizontal'`: top-rounded radius, accent bottom-border active indicator.
   *   Used inside `NavigationBar` and similar horizontal tab-bar contexts.
   * - `'mobile'`: stacked full-width layout when an owning navigation surface
   *   enters its narrow container mode.
   * - `'vertical'`: square row geometry, neutral selected surface, and accent inline-start border active indicator.
   *   Used inside `SideNavigation` (set automatically by `SideNavigationItem`) or
   *   standalone sidebar footers where flush sidebar edges are required.
   */
  variant?: 'horizontal' | 'mobile' | 'vertical';
  children: Snippet;
};
// `aria-current` and `aria-disabled` are owned by the component (derived from the
// `active` / `disabled` props and emitted after the attribute spread). They're
// Omit-ted from both arms so a consumer value is a compile error rather than being
// silently overridden at runtime. `disabled` is owned by `CommonArm`, so it's also
// Omit-ted from the button arm to keep a single source of truth (matching the
// `buttonAttributes` runtime cast).
// Forwarded through the flattened (non-generic) copies of svelte/elements' attribute
// interfaces — see `_internal/forwarded-html-attributes.generated.ts` (COR-239). Referencing
// the generic interfaces directly from both arms of this union pushes `keyof
// NavigationItemProps` (which svelte's `Component<Props, {}, Bindings>` computes for its
// `Bindings` constraint) over TypeScript's type complexity budget: TS2590 under a consumer's
// `skipLibCheck: false`.
export type LinkArm = CommonArm &
  Omit<
    FlatHTMLAnchorAttributes,
    'class' | 'href' | 'onclick' | 'aria-current' | 'aria-disabled'
  > & {
    /** Destination URL. Providing this prop renders the item as an `<a>` element instead of a `<button>`. */
    href: string;
    /**
     * Optional click handler called for the rendered `<a>` element. Useful for
     * intercepting plain left-clicks for SPA navigation while letting modified
     * clicks (cmd/ctrl/shift/alt or middle-click) fall through to native browser
     * behavior. Disabled-state preventDefault still applies.
     */
    onclick?: (event: MouseEvent) => void;
  };
type ButtonArm = CommonArm &
  Omit<
    FlatHTMLButtonAttributes,
    'class' | 'onclick' | 'disabled' | 'type' | 'aria-current' | 'aria-disabled'
  > & {
    href?: undefined;
    onclick: (event: MouseEvent) => void;
  };
/** Props for the NavigationItem component. Pass `href` for a link, `onclick` for a button. */
export type NavigationItemProps = LinkArm | ButtonArm;
