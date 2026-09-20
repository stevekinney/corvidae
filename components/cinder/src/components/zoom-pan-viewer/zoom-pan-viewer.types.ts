import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
export type ZoomPanViewerProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Additional class merged with the component's root class. */
  class?: string;
  /** Content the viewer pans and zooms. */
  children: Snippet;
  /**
   * Starting zoom scale. Bindable. Clamped to `0.25`–`8`; a non-finite
   * value normalizes to `1`. A programmatic external change to this prop
   * does not itself fire `onTransformChange` (see that prop). Defaults to
   * `1`.
   * @default 1
   */
  scale?: number;
  /**
   * Names the viewport. Does not describe the diagram itself. Defaults to
   * `'Zoomable viewer'`.
   * @default 'Zoomable viewer'
   */
  ariaLabel?: string;
  /**
   * Called with `{ scale, x, y }` after a pointer, keyboard, or control
   * interaction changes the pan or zoom transform. Not called when `scale`
   * changes only because the caller passed a new value externally—hosts
   * that need to react to that must watch `scale` themselves.
   */
  onTransformChange?: (transform: { scale: number; x: number; y: number }) => void;
};
