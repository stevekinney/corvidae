import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
/** Layout variant for the description list. */
export type DescriptionListVariant = 'default' | 'striped' | 'two-column' | 'narrow';
/**
 * A timestamp definition. It reads as a short date and time, and the exact
 * time (full date, seconds and time zone) shows on hover.
 */
export type DescriptionListTimestamp = {
  /** Marks the definition as a timestamp. */
  type: 'timestamp';
  /** The moment to show: a `Date`, an ISO string, or milliseconds since the epoch. */
  value: Date | string | number;
  /** Locale used to format both the readable and the exact time. @default "en-US" */
  locale?: string;
  /** IANA time zone used to format both. @default "UTC" */
  timeZone?: string;
};

/**
 * An identifier definition: an ID or hash, shortened and set in small
 * monospace, with an icon-only copy button that copies the whole value.
 */
export type DescriptionListIdentifier = {
  /** Marks the definition as an identifier. */
  type: 'identifier';
  /** The full identifier. Shown whole when it is short enough, shortened otherwise. */
  value: string;
  /**
   * How many characters to keep at the start before shortening. The last four
   * characters are always kept. An identifier of at most this many plus four
   * characters is shown whole.
   * @default 8
   */
  visibleCharacters?: number;
};

/**
 * A read-only tag list. Tags are shown as plain chips that cannot be removed.
 * System tags are counted rather than listed. An "Add a tag" button appears
 * when `onAddTag` is given.
 */
export type DescriptionListTags = {
  /** Marks the definition as a tag list. */
  type: 'tags';
  /** The tags to list, in order. */
  tags: string[];
  /** How many system tags the entity also carries. They are counted, never listed. @default 0 */
  systemTagCount?: number;
  /** Called when the reader activates "Add a tag". The action is hidden when this is omitted. */
  onAddTag?: () => void;
};

/** A definition the list formats itself: a timestamp, an identifier or a tag list. */
export type DescriptionListFormattedValue =
  DescriptionListTimestamp | DescriptionListIdentifier | DescriptionListTags;

/** Term definition content: plain text, rich snippet content, or a value the list formats. */
export type DescriptionListDefinition = string | Snippet | DescriptionListFormattedValue;
export type DescriptionListItem = {
  /**
   * Stable identity for keyed rendering. Falls back to `term` when omitted.
   * Provide an explicit `id` when the list may contain duplicate terms.
   */
  id?: string;
  /** The label rendered inside `<dt>`. */
  term: string;
  /**
   * The value rendered inside `<dd>`. Plain text, a snippet, or a formatted
   * value: `{ type: 'timestamp' }`, `{ type: 'identifier' }` or `{ type: 'tags' }`.
   */
  definition: DescriptionListDefinition;
};
export type DescriptionListProps = Omit<HTMLAttributes<HTMLDListElement>, 'class'> & {
  items: DescriptionListItem[];
  /**
   * Controls the visual layout:
   * - `default`: stacked rows with visible terms.
   * - `striped`: alternating row backgrounds.
   * - `two-column`: a muted term on the left and the value on the right, with no row dividers;
   *   collapses to stacked at narrow widths.
   * - `narrow`: `<dt>` is visually hidden via `.cinder-sr-only`. Only appropriate when
   *   surrounding context already labels the value. NOT a general compact mode.
   */
  variant?: DescriptionListVariant;
  /** Additional class merged onto the `.cinder-description-list` root element. */
  class?: string;
  /**
   * Optional snippet rendered once per row. Receives the full `DescriptionListItem` so
   * consumers can build disambiguated `aria-label` strings (e.g. `aria-label="Edit ${item.term}"`).
   * Any interactive element in `actions` MUST set an unambiguous `aria-label`.
   */
  actions?: Snippet<[DescriptionListItem]>;
};
