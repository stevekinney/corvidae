import type { Snippet } from 'svelte';
import type { HTMLLiAttributes } from 'svelte/elements';

/**
 * What the leading slot holds, which sets its size and alignment: an `icon` (a 28px glyph), an
 * `avatar` (40px), a `media` thumbnail (56px) or a `control` such as a checkbox or radio, which
 * aligns to the first line of a wrapping title.
 */
export type GroupedListItemLeadingKind = 'icon' | 'avatar' | 'media' | 'control';

/**
 * The closed vocabulary of a time-led row's lead unit: how much time is left (`min left`, `left`),
 * how long until it begins (`min to go`, `starts`), or the weekday it falls on. A range of times
 * never goes in the lead; it belongs in the content.
 */
export type GroupedListItemLeadUnit =
  | 'min left'
  | 'left'
  | 'min to go'
  | 'starts'
  | 'Mon'
  | 'Tue'
  | 'Wed'
  | 'Thu'
  | 'Fri'
  | 'Sat'
  | 'Sun';

/** How pressing a time-led row's lead is: `urgent` reads loudest, in the warning colour; `soon` is muted. */
export type GroupedListItemUrgency = 'urgent' | 'soon';

/** A text action at the end of a row: a secondary small button, or a link drawn as one. */
export type GroupedListItemAction = {
  /** The visible text of the button. */
  label: string;
  /** Destination URL. The action renders as a link drawn as a button. */
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
  /**
   * Marks the action as one that changes something (`data-changes`), so an application that holds
   * such controls while its server does not answer holds this one too.
   */
  changes?: boolean;
};

/** Props for the GroupedListItem component. */
export type GroupedListItemProps = Omit<HTMLLiAttributes, 'class' | 'children' | 'title'> & {
  /** The row's main text. With `href`, it becomes the link and the whole row is its target. */
  title: Snippet;
  /** A secondary line under the title, in muted text. A status is a small dot plus a word here, never a badge. */
  subtitle?: Snippet;
  /** A leading icon, thumbnail, avatar or control, drawn before the text. */
  leading?: Snippet;
  /**
   * What the leading slot holds.
   * @default 'icon'
   */
  leadingKind?: GroupedListItemLeadingKind;
  /** A fixed-width column for a time or number, such as "45 min left", drawn before the title. Rows in one list line up. */
  lead?: Snippet;
  /** The number or word of a time-led row's lead, such as `45` or `9:30`, drawn large. Pair it with `leadUnit`. Ignored when a `lead` snippet is given. A range of times never goes here. */
  leadValue?: string | number;
  /** The small unit under the lead number, from a closed vocabulary. Used with `leadValue`. */
  leadUnit?: GroupedListItemLeadUnit;
  /** How pressing the lead is. `urgent` uses the warning text colour and `soon` is muted; left unset, the lead uses the default text colour. Used with `leadValue`. */
  urgency?: GroupedListItemUrgency;
  /** A short age, such as `3d`, drawn with a gray clock before the trailing value. Give it only when the row's information is stale; a fresh row draws no marker. */
  staleAge?: string;
  /** A trailing 56px photo. It reserves no space when absent. */
  photo?: Snippet;
  /** A trailing value, such as a count or a short status. It is right-aligned and never moves the action column. */
  trailing?: Snippet;
  /** A trailing action such as a menu button. It sits in a fixed-width column, so a changing value never moves its click target. */
  action?: Snippet;
  /**
   * Text actions at the end of the row, each a secondary small button (a link drawn as one when it
   * has `href`), for a row whose action is the point of the row, such as a review waiting on you.
   * They sit above the row's own link. In a row narrower than 26rem, as on a phone, they leave the
   * end of the row for a line of their own under its text, each at its own width from the text's
   * leading edge, never collapsing into a menu, each a 44px target under a coarse pointer.
   */
  actions?: GroupedListItemAction[];
  /** Draws a trailing chevron. Left unset, a row with `href` draws one. */
  chevron?: boolean;
  /**
   * Marks the row as the current one with a tint.
   * @default false
   */
  selected?: boolean;
  /**
   * Marks the row as a suggestion that is not saved until the person confirms it: a quiet accent
   * text label on a line above the title, with no tint, border or pill.
   * @default false
   */
  suggested?: boolean;
  /**
   * The words of the suggested label, such as "Suggested wording". Used with `suggested`.
   * @default "Suggested"
   */
  suggestedLabel?: string;
  /** Makes the whole row a link to this address. */
  href?: string;
  /** Where to open the link. */
  target?: string;
  /** The link's relationship; `noopener noreferrer` is added for `_blank`. */
  rel?: string;
  /** Custom class merged with `.cinder-grouped-list-item`. */
  class?: string;
};
