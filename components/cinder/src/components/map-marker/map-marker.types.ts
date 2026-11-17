import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';

/** The states a map marker can show. */
export type MapMarkerState = 'live' | 'idle' | 'selected' | 'cluster';

/** Props for the MapMarker component. */
export type MapMarkerProps = Omit<HTMLButtonAttributes, 'class' | 'children' | 'type'> & {
  /** The marker's state. `live` is a filled pill with a dot, `idle` an outlined pill, `selected` a raised pill with a ring, and `cluster` a round count with no tail. Defaults to `idle`. */
  state?: MapMarkerState;
  /** Visible text: a start time such as "8 pm" for an idle marker, a short word for a live one, or the count for a cluster. State is never carried by colour alone. */
  label: string;
  /** Decorative glyph drawn before the label. It is hidden from assistive technology. */
  icon?: Snippet;
  /** Accessible name of the marker, such as "Union Station Bar, happy hour starts 8 pm". Left unset, the label is the name and the state is appended as hidden text. */
  name?: string;
  /** Custom class merged with `.cinder-map-marker`. */
  class?: string;
};
