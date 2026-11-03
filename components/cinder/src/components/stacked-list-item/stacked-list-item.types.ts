import type { Snippet } from 'svelte';
import type { HTMLAnchorAttributes, HTMLAttributes } from 'svelte/elements';
export type StackedListItemDensity = 'comfortable' | 'condensed';
/**
 * Where a row's status sits. `leading` is the fixed 128px column that leads the row on a tablet
 * or desktop; `line-two` puts the status in a fixed-width column at the start of line two, for a
 * pane too narrow for a leading column (the chat list). On a phone a `leading` status moves to
 * line two in any case.
 */
export type StackedListItemStatusPlacement = 'leading' | 'line-two';
/** How many lines a row's title may take before it ends in an ellipsis. */
export type StackedListItemTitleLines = 1 | 2;
/** A text action at the end of a row. */
export type StackedListItemAction = {
  /** The visible text of the button, and the text of its item in the phone menu. */
  label: string;
  /** Destination URL. The action renders as a link instead of a button. */
  href?: string;
  /** Called when the action is chosen. */
  onclick?: (event: MouseEvent) => void;
  /**
   * Whether the action is unavailable. It stays focusable and keeps `aria-disabled`, so the
   * reason can be found; choosing it does nothing.
   */
  disabled?: boolean;
  /** Why the action is unavailable, said as its description and its tooltip. */
  disabledReason?: string;
};
type LiEventAttribute = Extract<keyof HTMLAttributes<HTMLLIElement>, `on${string}`>;
type ForwardedLiAttributes = Omit<
  HTMLAttributes<HTMLLIElement>,
  'title' | 'class' | 'role' | 'tabindex' | LiEventAttribute
>;
type StackedListItemBase = ForwardedLiAttributes & {
  /**
   * Density token surfaced as `data-cinder-density`. When omitted, inherits the
   * enclosing DataList's list-level `density` (if any), then falls back to
   * `comfortable`. An explicit value here always overrides the list default.
   */
  density?: StackedListItemDensity;
  /** Leading visual (avatar, icon, status dot). With a status column it follows the column. */
  leading?: Snippet;
  /**
   * The row's status: a `StatusDot` with its word. It leads the row in a fixed 128px column that
   * every list on every page shares, so titles start at one x position down the list; on a phone
   * it moves to line two, before the meta. The dot and word sit on the first line of the title.
   */
  status?: Snippet;
  /**
   * Keep the status column's width even when this row has no `status` (a workflow or an agent
   * with nothing to report), so titles line up. Inherits the enclosing DataList's
   * `statusColumn`. Setting it on a row that has a `status` has no effect.
   */
  statusColumn?: boolean;
  /** Where the status sits. Default `leading`. */
  statusPlacement?: StackedListItemStatusPlacement;
  /** Primary label. Required. */
  title: Snippet;
  /**
   * How many lines the title may take before an ellipsis. Default `2`; the status and the time
   * stay beside the first line, and the full title is the row's `tooltip`. A title never grows a
   * row without bound, and an unbroken value (an identifier) wraps anywhere.
   */
  titleLines?: StackedListItemTitleLines;
  /**
   * The full title as text, shown as the row's tooltip when the title is clamped. Set it to the
   * same text the `title` snippet renders.
   */
  tooltip?: string;
  /**
   * The time, or the next run, at the right edge of line one, aligned to its top. Pass a
   * `RelativeTime` or a plain string.
   */
  time?: Snippet;
  /** Secondary description below the title. */
  description?: Snippet;
  /**
   * Line two: muted metadata, kind first, then agent, then detail, joined by middots. It starts
   * under the title (not under the status) and ends in an ellipsis rather than wrapping. A line
   * that must carry a control (an error with its own "Try again") may put one in.
   */
  meta?: Snippet;
  /** Trailing region (chevron, action button, dropdown trigger). */
  trailing?: Snippet;
  /**
   * Text actions at the end of the row. On a tablet or desktop each is a secondary small button;
   * on a phone (below 640px) they collapse into one menu button with the same actions, which is a
   * 44px target under a coarse pointer.
   */
  actions?: StackedListItemAction[];
  /** Accessible name of the phone menu button that holds `actions`. Default `More actions`. */
  actionsLabel?: string;
  /**
   * Turns the row into a collapsed group row (the missed runs on Runs): a "Show" / "Hide" button
   * at the right of line one reveals this snippet beneath the row, aligned with the title. A
   * group row is not a link.
   */
  details?: Snippet;
  /** Whether a group row's `details` are showing. Bindable; default `false`. */
  expanded?: boolean;
  /** Text of the button that opens a group row. Default `Show`. */
  expandLabel?: string;
  /** Text of the button that closes a group row. Default `Hide`. */
  collapseLabel?: string;
  /** Merged with `cinder-stacked-list-item`. */
  class?: string;
};
/** Non-linkified row — `title` snippet renders as plain text. */
type StackedListItemStatic = StackedListItemBase & {
  href?: never;
  target?: never;
  rel?: never;
  hreflang?: never;
};
/** Linkified row — `title` snippet renders as `<a href>`. */
type StackedListItemLinked = StackedListItemBase & {
  /**
   * Destination URL that turns the `title` snippet into an `<a>` link. The link covers the whole
   * row, so the row is one target: hover tints the whole row and the keyboard focus ring wraps it.
   * Controls inside the row (`actions`, `trailing`, a button in `meta`) stay separately usable.
   */
  href: string;
  /** Browsing context for the title anchor (`_blank`, `_self`, `_parent`, `_top`, or a named frame). */
  target?: HTMLAnchorAttributes['target'];
  /** `rel` attribute forwarded to the title anchor; `noopener noreferrer` is merged automatically when `target="_blank"`. */
  rel?: HTMLAnchorAttributes['rel'];
  /** `hreflang` attribute forwarded to the title anchor, indicating the language of the linked resource. */
  hreflang?: HTMLAnchorAttributes['hreflang'];
};
export type StackedListItemProps = StackedListItemStatic | StackedListItemLinked;
