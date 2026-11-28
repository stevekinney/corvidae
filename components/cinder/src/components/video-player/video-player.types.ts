import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/**
 * A moment marked on the seek track, such as a review comment.
 * @schemaObject
 */
export type VideoPlayerMarker = {
  /** Position in seconds. A marker past the video's length is not drawn. */
  time: number;
  /** Short visible text on the marker, such as its number. */
  badge: string;
  /** Accessible name of the marker's button, such as "Comment 1 at 0:12". */
  label: string;
};

/**
 * A titled section of the video, listed under the controls.
 * @schemaObject
 */
export type VideoPlayerChapter = {
  /** Start of the chapter in seconds. */
  time: number;
  /** Visible title, read after the start time. */
  title: string;
};

/** Values the `actions` snippet receives. */
export type VideoPlayerActionsContext = {
  /** Playback position in seconds. */
  currentTime: number;
};

/** Props for the VideoPlayer component. */
export type VideoPlayerProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. */
  src: string;
  /** Accessible name for the player. */
  label: string;
  /** Image shown before playback starts. */
  poster?: string;
  /**
   * Moments drawn as buttons on the seek track once the length is known. Each seeks to its
   * `time`; close markers overlap, and the tab order reaches them in ascending `time`.
   */
  markers?: VideoPlayerMarker[];
  /** Sections listed as buttons under the controls, each named by its start time and title. */
  chapters?: VideoPlayerChapter[];
  /**
   * Accessible name of the chapter group.
   * @default "Chapters"
   */
  chaptersLabel?: string;
  /**
   * Rates the playback speed menu offers.
   * @default [0.5, 1, 1.5, 2]
   */
  playbackRates?: number[];
  /**
   * Playback position in seconds; bindable. Writing it seeks, clamped to the length, and a value
   * written before the length is known is applied once it is.
   * @default 0
   */
  currentTime?: number;
  /** Content drawn last in the controls row, given the current position. */
  actions?: Snippet<[VideoPlayerActionsContext]>;
  /** Additional class names merged with `.cinder-video-player`. */
  class?: string;
};

/** Cinder-specific props for VideoPlayer, used by the schema generator. */
export interface VideoPlayerSchemaProps {
  /** Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. */
  src: string;
  /** Accessible name for the player. */
  label: string;
  /** Image shown before playback starts. */
  poster?: string;
  /**
   * Moments drawn as buttons on the seek track once the length is known. Each seeks to its
   * `time`; close markers overlap, and the tab order reaches them in ascending `time`.
   */
  markers?: VideoPlayerMarker[];
  /** Sections listed as buttons under the controls, each named by its start time and title. */
  chapters?: VideoPlayerChapter[];
  /**
   * Accessible name of the chapter group.
   * @default "Chapters"
   */
  chaptersLabel?: string;
  /**
   * Rates the playback speed menu offers.
   * @default [0.5, 1, 1.5, 2]
   */
  playbackRates?: number[];
  /**
   * Playback position in seconds; bindable. Writing it seeks, clamped to the length, and a value
   * written before the length is known is applied once it is.
   * @default 0
   */
  currentTime?: number;
  /** Content drawn last in the controls row, given the current position. */
  actions?: Snippet<[VideoPlayerActionsContext]>;
  /** Additional class names merged with `.cinder-video-player`. */
  class?: string;
}
