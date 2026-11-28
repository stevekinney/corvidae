import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Layout mode: compact icon-only or expanded icon+label. */
export type MediaControlsLayout = 'compact' | 'expanded';

/** Props for the private MediaControls that AudioPlayer and VideoPlayer render. */
export type MediaControlsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'onplay' | 'onpause'
> & {
  /** Current playback state. @default "paused" */
  playing?: boolean;
  /** Show a replay action instead of play/pause when the track has ended. @default false */
  replay?: boolean;
  /** Disable all controls. @default false */
  disabled?: boolean;
  /** Show a loading spinner and prevent interaction while media is buffering. @default false */
  loading?: boolean;
  /** Controls are unavailable (e.g. media source missing). @default false */
  unavailable?: boolean;
  /** Progress value between 0 and 1. Omit to hide the progress bar. */
  progress?: number | undefined;
  /** Human-readable accessible label for the progress bar. @default "Playback progress" */
  progressLabel?: string;
  /** Layout mode: `compact` renders icon-only, `expanded` renders icon+label. @default "compact" */
  layout?: MediaControlsLayout;
  /** Called when the user triggers playback. */
  onPlay?: () => void;
  /** Called when the user pauses playback. */
  onPause?: () => void;
  /** Called when the user triggers replay. */
  onReplay?: () => void;
  /**
   * Called with the requested position (0 to 1) when the user drags or keys the seek slider.
   * Providing it turns the progress bar into a seek slider; it needs `progress` to render.
   */
  onSeek?: (progress: number) => void;
  /** Playback position in seconds. With a finite `duration`, shows the elapsed and total time. */
  elapsed?: number | undefined;
  /** Total length in seconds. With `elapsed`, shows the time and moves the seek slider by seconds. */
  duration?: number | undefined;
  /** Whether the sound is muted. @default false */
  muted?: boolean;
  /** Called when the user toggles mute. Providing it renders the mute toggle. */
  onToggleMute?: () => void;
  /** Whether the player fills the screen. @default false */
  fullscreen?: boolean;
  /** Called when the user toggles full screen. Providing it renders the full-screen toggle. */
  onToggleFullscreen?: (() => void) | undefined;
  /**
   * Called when the user steps back five seconds. Providing it renders a "Back 5 seconds" button
   * after the play button.
   */
  onBack?: (() => void) | undefined;
  /**
   * Draws the seek slider on its own row above the buttons, which then wrap, so the slider comes
   * first in the tab order. @default false
   */
  seekAbove?: boolean;
  /** Content laid over the seek slider in the `seekAbove` layout, after it in the tab order. */
  seekOverlay?: Snippet | undefined;
  /** Controls drawn after the elapsed and total time, before mute and full screen. */
  secondary?: Snippet | undefined;
  /** Content drawn last in the row, at its inline end. */
  trailing?: Snippet | undefined;
  /** Additional class names merged with `.cinder-media-controls`. */
  class?: string;
};
