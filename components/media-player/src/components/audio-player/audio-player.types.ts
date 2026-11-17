import type { HTMLAttributes } from 'svelte/elements';

/** Props for the AudioPlayer component. */
export type AudioPlayerProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. */
  src: string;
  /** Accessible name for the player. */
  label: string;
  /** Additional class names merged with `.cinder-audio-player`. */
  class?: string;
};

/** Cinder-specific props for AudioPlayer, used by the schema generator. */
export interface AudioPlayerSchemaProps {
  /** Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. */
  src: string;
  /** Accessible name for the player. */
  label: string;
  /** Additional class names merged with `.cinder-audio-player`. */
  class?: string;
}
