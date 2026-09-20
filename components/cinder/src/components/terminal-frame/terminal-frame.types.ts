import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

export type TerminalFrameStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export type TerminalFrameDimensions = {
  cols: number;
  rows: number;
};

export type TerminalFrameProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'title'> & {
  /** Title shown in the frame chrome. */
  title: string;
  /** Connection status shown in the frame chrome. Defaults to `'connecting'`. @default 'connecting' */
  status?: TerminalFrameStatus;
  /**
   * Recovery error message. The recovery UI is gated on `error` alone, not
   * on `status`—if `error` stays set after `status` moves away from
   * `'error'` (for example to `'connected'`), the recovery UI remains
   * visible until the caller clears `error` too.
   */
  error?: string;
  /**
   * Called when the user requests a reload from the recovery UI. The
   * recovery UI (and this button) show whenever `error` is set, regardless
   * of the current `status`.
   */
  onReloadRequest?: () => void;
  /** Called with `{ cols, rows }` whenever the character-cell size changes, so the host can resize its PTY. */
  onDimensionsChange?: (dimensions: TerminalFrameDimensions) => void;
  /**
   * Character-cell width, in pixels, used to compute `{ cols, rows }` on
   * resize. Defaults to `8`.
   * @default 8
   */
  columnWidth?: number;
  /**
   * Character-cell height, in pixels, used to compute `{ cols, rows }` on
   * resize. Defaults to `18`.
   * @default 18
   */
  rowHeight?: number;
  /** Consumer-owned PTY renderer. */
  children: Snippet;
  /** Additional class merged with the component's root class. */
  class?: string;
};
