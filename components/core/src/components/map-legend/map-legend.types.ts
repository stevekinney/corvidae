import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { MapMarkerState } from '../map-marker/map-marker.types.ts';

/** One legend entry: a marker state and what it means. */
export type MapLegendItem = {
  /** The marker state this entry draws. Each state has its own shape, so the key never relies on colour. */
  state: MapMarkerState;
  /** What the state means, such as "Happy hour now". */
  label: string;
};

/** Props for the MapLegend component. */
export type MapLegendProps = Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> & {
  /** The marker states the map uses, in reading order. */
  items: MapLegendItem[];
  /** Accessible name of the legend, such as "Map key". Left unset, the legend is unnamed. */
  label?: string;
  /** Replaces the attribution text. It is always rendered; leave it unset for the OpenStreetMap and ODbL credit. */
  attribution?: Snippet;
  /** Custom class merged with `.cinder-map-legend`. */
  class?: string;
};
