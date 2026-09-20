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
  /** Connection status shown in the frame chrome. */
  status?: TerminalFrameStatus;
  /** Recovery error message. Shown with recovery UI when `status` is `error`. */
  error?: string;
  /** Called when the user requests a reload from the recovery UI shown when `status` is `error`. */
  onReloadRequest?: () => void;
  /** Called with `{ cols, rows }` whenever the character-cell size changes, so the host can resize its PTY. */
  onDimensionsChange?: (dimensions: TerminalFrameDimensions) => void;
  /** Character-cell width, in pixels, used to compute `{ cols, rows }` on resize. */
  columnWidth?: number;
  /** Character-cell height, in pixels, used to compute `{ cols, rows }` on resize. */
  rowHeight?: number;
  /** Consumer-owned PTY renderer. */
  children: Snippet;
  /** Additional class merged with the component's root class. */
  class?: string;
};
