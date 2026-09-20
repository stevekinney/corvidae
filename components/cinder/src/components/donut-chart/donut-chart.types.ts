import type { HTMLAttributes } from 'svelte/elements';
export type DonutChartDatum = { label: string; value: number; color?: string };
export type DonutChartProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Names both the chart and its generated data table. */
  label: string;
  /** Part-to-whole values rendered as the ring and the non-visual data table. */
  data: DonutChartDatum[];
  /** Adds visible value labels to the chart. */
  valueLabels?: boolean;
  /** Supplemental label rendered at the ring's center. Should not be the only explanation of the total. */
  centerLabel?: string;
  /** Enables a horizontal-scroll escape hatch for narrow containers. */
  scrollable?: boolean;
  /** Called when a series is activated. Provide only when the series is actionable. */
  onSeriesClick?: (datum: DonutChartDatum, index: number) => void;
  /** Additional class merged with the component's root class. */
  class?: string;
};
