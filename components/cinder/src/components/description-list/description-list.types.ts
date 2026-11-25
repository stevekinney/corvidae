import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
/** Layout variant for the description list. */
export type DescriptionListVariant =
  'default' | 'striped' | 'two-column' | 'narrow' | 'facts' | 'fields' | 'grid';
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
  /** The quiet words for an empty tag list. @default "No tags" */
  emptyLabel?: string;
  /** How many system tags the entity also carries. They are counted, never listed. @default 0 */
  systemTagCount?: number;
  /** Called when the reader activates "Add a tag". The action is hidden when this is omitted. */
  onAddTag?: () => void;
};

/**
 * A code definition: text set in the code font and broken anywhere, such as a command or a value
 * written as JSON. Shown whole, never shortened.
 */
export type DescriptionListCode = {
  /** Marks the definition as code. */
  type: 'code';
  /** The text, shown exactly. */
  value: string;
};

/**
 * An empty definition: a field that holds nothing, written as a quiet word such as "None" or
 * "Empty" so it never reads as a value someone typed.
 */
export type DescriptionListEmpty = {
  /** Marks the definition as empty. */
  type: 'empty';
  /** The word for nothing, such as `None` or `Empty`. */
  label: string;
};

/** A definition the list formats itself: a timestamp, an identifier, a tag list, code or an empty field. */
export type DescriptionListFormattedValue =
  | DescriptionListTimestamp
  | DescriptionListIdentifier
  | DescriptionListTags
  | DescriptionListCode
  | DescriptionListEmpty;

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
   * value: `{ type: 'timestamp' }`, `{ type: 'identifier' }`, `{ type: 'tags' }`,
   * `{ type: 'code' }` or `{ type: 'empty' }`.
   */
  definition: DescriptionListDefinition;
  /**
   * Gives a long value the whole row in the `grid` and `facts` variants instead of one column: a
   * value that wraps past about two lines in a column, runs over several lines, or is code. The
   * other variants already give every value the row.
   * @default false
   */
  wide?: boolean;
  /**
   * A muted second line under the definition, for what the value is called elsewhere (a check
   * read in words, with its name and version beneath). It is plain text read with the definition,
   * and is left out when empty.
   */
  note?: string;
  /**
   * An identifier the note starts with, drawn in the mono family at the note's size, such as a
   * workflow's `agentRun` before "(built in)". It is drawn with or without `note`, a space apart
   * from it, and is left out when empty.
   */
  noteCode?: string;
  /**
   * Where the row leads, such as the page of the record a value names. A row with an address ends
   * in a trailing chevron, and the whole row is its link target; a row without one is read-only and
   * draws no chevron, so a row that goes somewhere never looks like one that does not. The link is
   * named for the term and, when the definition is plain text, its value.
   */
  href?: string;
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
   * - `fields`: a record read as a list: a regular-weight muted term in a fixed 140px column, its value
   *   beside it, each row at least 44px tall flat, with a quiet rule under each (`framed` adds a tinted group,
   *   raised while the list is narrower than 700px); a row with an `href` ends in a trailing chevron; the term stacks above its value
   *   while the list is narrower than 23rem (368px).
   * - `facts`: one row of equal columns, each a muted term above its value, between two quiet
   *   rules (the queues, tasks, workflow and version of a worker); wraps to more rows as the
   *   container narrows.
   * - `grid`: the pairs flow in as many equal columns as the list's own width fits (about 6.5rem
   *   each), each a muted term above its value at the column's start edge, with no rules and no
   *   fill: a wide card reads three short pairs on one row, a phone two, a narrow column one. A
   *   `wide` item takes the whole row.
   */
  variant?: DescriptionListVariant;
  /**
   * Puts every term above its value at any width. The `two-column` variant
   * already stacks once its own container is narrower than 28rem; `stack`
   * stacks it regardless, for a list whose page has already chosen its phone
   * layout. Has no effect on `narrow`, whose terms stay visually hidden.
   * @default false
   */
  stack?: boolean;
  /**
   * Keeps the tinted, rounded frame around the `fields` variant. The variant is flat by default, so
   * a record inside a pane or a card never draws a box inside a box; set this where the list stands
   * alone on the page canvas. While the list is narrower than 700px of its own width the frame takes
   * the raised fill of a grouped list, as an Inspector's group does below 700px of its own. Has no
   * effect on any other variant.
   * @default false
   */
  framed?: boolean;
  /** Additional class merged onto the `.cinder-description-list` root element. */
  class?: string;
  /**
   * Optional snippet rendered once per row. Receives the full `DescriptionListItem` so
   * consumers can build disambiguated `aria-label` strings (e.g. `aria-label="Edit ${item.term}"`).
   * Any interactive element in `actions` MUST set an unambiguous `aria-label`.
   */
  actions?: Snippet<[DescriptionListItem]>;
};
