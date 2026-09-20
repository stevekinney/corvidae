import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
export type ZoomPanViewerProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Additional class merged with the component's root class. */
  class?: string;
  /** Content the viewer pans and zooms. */
  children: Snippet;
  /**
   * Starting zoom scale. Defaults to `1`.
   * @default 1
   */
  scale?: number;
  /** Names the viewport. Does not describe the diagram itself. */
  ariaLabel?: string;
  /** Called with `{ scale, x, y }` whenever the pan or zoom transform changes, for hosts that persist or mirror it. */
  onTransformChange?: (transform: { scale: number; x: number; y: number }) => void;
};
