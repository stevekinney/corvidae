import type { HTMLAttributes } from 'svelte/elements';

/** Props for the VideoPlayer component. */
export type VideoPlayerProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. */
  src: string;
  /** Accessible name for the player. */
  label: string;
  /** Image shown before playback starts. */
  poster?: string;
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
  /** Additional class names merged with `.cinder-video-player`. */
  class?: string;
}
