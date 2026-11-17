import type { Snippet } from 'svelte';

type CommandItemBaseProps = {
  /** Submitted value; surfaced through the registration record. */
  value: string;
  /** When true, the item is skipped by arrow keys and cannot be activated. */
  disabled?: boolean;
  /** Optional secondary text shown below the main label. */
  description?: string;
  /** Accessible name for the option when the rendered row contains secondary text or rich content. */
  accessibleLabel?: string | undefined;
  /** Keyboard shortcut exposed through `aria-keyshortcuts`, e.g. `Meta+N`. */
  keyboardShortcut?: string | undefined;
  /**
   * A key sequence shown at the end of the row, read as "G then H": each key in a `Kbd`, with "then"
   * between them. One key shows alone ("C"). It is text in the row, so it joins the option's
   * accessible name unless `accessibleLabel` is set; it does not set `aria-keyshortcuts`, which
   * describes a chord, not a sequence. Pass `keyboardShortcut` as well for a chord.
   */
  keys?: readonly string[] | undefined;
  /** Leading content (icon, avatar). Rendered with aria-hidden. */
  leading?: Snippet;
  /**
   * How the leading content is drawn. `neutral` is a bare glyph in muted ink; `warning` is the
   * glyph on a small amber tile, for a row that is waiting on the person.
   * @default "neutral"
   */
  leadingTone?: 'neutral' | 'warning' | undefined;
  /**
   * Secondary text on the label's own line, after it and muted ("Refund order 4471 for $42.00?"
   * with the meta "Approval, waiting"). The label and the meta truncate together as one line. Rendered with
   * aria-hidden, so name the row with `accessibleLabel` when the meta carries meaning.
   */
  meta?: Snippet;
  /** Trailing content (kbd hint, badge). Rendered with aria-hidden. */
  trailing?: Snippet;
  /** Main label content. */
  children: Snippet;
  /** Class merged with `.cinder-command-item`. */
  class?: string;
};

type CommandItemOwnsSelectionProps = {
  /** Invoked when the item is activated inside CommandPalette. */
  onSelect: () => void;
  /**
   * `selectionMode` is a compile-time discriminant that only controls whether
   * `onSelect` is required; it has no runtime effect on activation dispatch.
   * `'item'` is the default CommandPalette mode, in which this component's
   * own `onSelect` is required.
   */
  selectionMode?: 'item';
};

type CommandItemParentOwnsSelectionProps = {
  /**
   * `selectionMode` is a compile-time discriminant that only controls whether
   * `onSelect` is required; it has no runtime effect on activation dispatch.
   * `'parent'` makes `onSelect` optional at the type level for integrations
   * such as CommandMenu, where a parent list owns activation — it does not
   * change which activation handler actually runs.
   */
  selectionMode: 'parent';
  /** Optional fallback for custom parent integrations. */
  onSelect?: () => void;
};

export type CommandItemProps = CommandItemBaseProps &
  (CommandItemOwnsSelectionProps | CommandItemParentOwnsSelectionProps);
