import type { Snippet } from 'svelte';
import type { HTMLLiAttributes } from 'svelte/elements';

/**
 * What the leading slot holds, which sets its size and alignment: an `icon` (a 28px glyph), an
 * `avatar` (40px), a `media` thumbnail (56px) or a `control` such as a checkbox or radio, which
 * aligns to the first line of a wrapping title.
 */
export type GroupedListItemLeadingKind = 'icon' | 'avatar' | 'media' | 'control';

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
  /** A trailing photo. It reserves no space when absent. */
  photo?: Snippet;
  /** A trailing value, such as a count or a short status. It is right-aligned and never moves the action column. */
  trailing?: Snippet;
  /** A trailing action such as a menu button. It sits in a fixed-width column, so a changing value never moves its click target. */
  action?: Snippet;
  /** Draws a trailing chevron. Left unset, a row with `href` draws one. */
  chevron?: boolean;
  /**
   * Marks the row as the current one with a tint.
   * @default false
   */
  selected?: boolean;
  /** Makes the whole row a link to this address. */
  href?: string;
  /** Where to open the link. */
  target?: string;
  /** The link's relationship; `noopener noreferrer` is added for `_blank`. */
  rel?: string;
  /** Custom class merged with `.cinder-grouped-list-item`. */
  class?: string;
};
