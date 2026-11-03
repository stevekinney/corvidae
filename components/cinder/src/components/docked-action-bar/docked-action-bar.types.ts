import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/**
 * How the bar is drawn. `'strip'` is flush with its container and has only a top border (the
 * phone decision bar). `'card'` is a bordered, rounded, raised card (the run page on a wide screen).
 */
export type DockedActionBarVariant = 'strip' | 'card';

/** Props for the DockedActionBar component. */
export type DockedActionBarProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'role' | 'aria-label' | 'aria-labelledby'
> & {
  /**
   * Accessible name of the bar, read as the name of its group: "Run actions", "Decision".
   * @default "Actions"
   */
  label?: string;
  /**
   * How the bar is drawn: a flush strip with only a top border, or a bordered, raised card. The bar
   * docks to the bottom of a short page when its parent is a flex column at least as tall as the
   * scrolling area; the parent's `gap` sets the space above the bar.
   * @default "strip"
   */
  variant?: DockedActionBarVariant;
  /**
   * Turns the bar's actions off together, for one reason. Controls inside that opted in with
   * `mutating` go inert (`aria-disabled`, still focusable, described by `reason`), exactly as under
   * a `<StaleRegion>`, and the bar draws `reason` under its row. A field in the bar is the page's to
   * make read-only; the bar mutes an `Input` or `Textarea` inside it while it is off. The bar keeps
   * its place and its height, so nothing under it moves.
   * @default false
   */
  off?: boolean;
  /**
   * Why the actions are off, drawn under the row and read as the description of every inert
   * control: "Reconnecting… Send a message and Cancel run are off until the connection is back."
   * It is announced politely when it appears. Ignored while the bar is not `off`.
   */
  reason?: string;
  /**
   * Gives the actions equal widths, so a pair such as Deny and Approve share the row evenly. On a
   * narrow bar the actions take their own row under the content and share it; with no content they
   * fill the bar.
   * @default false
   */
  equalActions?: boolean;
  /** Custom class merged with `.cinder-docked-action-bar`. */
  class?: string;
  /** The leading part of the bar: a field, a consequence line. It takes the room the actions leave. */
  children?: Snippet;
  /** The buttons, kept together at the end of the row. */
  actions: Snippet;
};
