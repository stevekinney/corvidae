import type { HTMLAttributes } from 'svelte/elements';
export type DonutChartDatum = { label: string; value: number; color?: string };
export type DonutChartProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Names both the chart and its non-visual fallback list. */
  label: string;
  /**
   * Part-to-whole values rendered as the ring and, when `valueLabels` is
   * off, as a screen-reader-only fallback `<ul>` (not a data table).
   */
  data: DonutChartDatum[];
  /**
   * Adds a visible `<ul>` legend with value labels below the ring, in place
   * of the screen-reader-only fallback list. Defaults to `false`.
   * @default false
   */
  valueLabels?: boolean;
  /** Supplemental label rendered at the ring's center. Should not be the only explanation of the total. */
  centerLabel?: string;
  /**
   * Enables a horizontal-scroll escape hatch for narrow containers.
   * Defaults to `false`.
   * @default false
   */
  scrollable?: boolean;
  /** Called when a series is activated. Provide only when the series is actionable. */
  onSeriesClick?: (datum: DonutChartDatum, index: number) => void;
  /** Additional class merged with the component's root class. */
  class?: string;
};
