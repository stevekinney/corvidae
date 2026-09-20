import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
export type TerminalForeground =
  0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
export type TerminalTextRun = { text: string; foreground?: TerminalForeground; bold?: boolean };
export type TerminalLine = readonly TerminalTextRun[];
export type TerminalOutputProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /**
   * ANSI output text. Supports SGR 16-color foregrounds, bold/reset,
   * carriage-return rewrites, and erase-line sequences. Defaults to `''`.
   * @default ''
   */
  value?: string;
  /**
   * Keeps the viewport anchored to the latest line while appending.
   * Bindable, and not host-exclusive while bound: the component's own
   * scroll handler reassigns it to `true` whenever the user scrolls back
   * to the bottom, which resumes automatic scrolling on the next append.
   * Setting `false` marks the current state, not a mode the component
   * will leave alone—a host that wants to keep owning scroll position
   * after that point must not bind `followLatest` (handle scrolling
   * itself instead). Defaults to `true`.
   * @default true
   */
  followLatest?: boolean;
  /** Additional class merged with the component's root class. */
  class?: string;
  /** Rendered in place of the ANSI output when `value` is empty, e.g. an empty state. */
  children?: Snippet;
};
