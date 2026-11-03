import type { Snippet } from 'svelte';
export type CommandPaletteProps = {
  /**
   * Bindable open state. The component mutates `open = false` on Escape,
   * backdrop click, or any explicit close path, then fires `onClose`.
   */
  open: boolean;
  /** Placeholder rendered inside the search input. */
  placeholder?: string;
  /** Accessible name for the dialog, wired via `aria-label`. */
  label?: string;
  /**
   * Bindable search query. Mutated by the input's oninput handler.
   * Exposed to the items snippet so consumers can filter.
   * Reset to an empty string each time the palette opens.
   */
  query?: string;
  /** Fired after any close path routed through the palette close lifecycle. */
  onClose?: () => void;
  /** Element to restore focus to on close. Falls back to `captureFocus()`. */
  triggerRef?: HTMLElement | null;
  /** Receives the current query so consumers can filter. */
  items: Snippet<[{ query: string }]>;
  /** Rendered when zero items are registered after filtering. */
  empty?: Snippet;
  /** Optional footer, e.g. for keybinding hints. Not part of the listbox. */
  footer?: Snippet;
  /**
   * Viewport width below which the palette opens as a bottom sheet instead of a centred panel: it
   * docks to the bottom edge with a grabber, a search field with a Close button, 44px rows, and a
   * height capped so the list scrolls inside it. It rides above the on-screen keyboard and
   * respects the bottom safe area. A CSS length such as `"640px"`, or `false` to keep the centred
   * panel at every width.
   * @default "640px"
   */
  sheetBelow?: string | false;
  /**
   * Accessible name and visible text of the Close button the sheet form shows beside the search
   * field.
   * @default "Close"
   */
  closeLabel?: string;
  /** Class merged onto the palette panel. */
  class?: string;
};
