import type { HTMLAttributes } from 'svelte/elements';
import type { ChartTheme, ChartThemeSchema } from '../chart.types.ts';

export type SparkbarSize = 'sm' | 'md' | 'lg';
export type SparkbarVariant = 'accent' | 'success' | 'warning';

/** Props shared by both arms of Sparkbar. */
type SparkbarSharedProps = HTMLAttributes<HTMLDivElement> & {
  /** Track thickness and text scale. Default `md`. For a line, the height of the plot: 3rem, 6rem or 8rem. */
  size?: SparkbarSize;
  /** Partial visual theme override. Omitted fields inherit the surrounding application. */
  theme?: ChartTheme;
  /** Accessible name override. Defaults to `${label}, ${percentage}%` for a bar, and to `label` for a line. */
  ariaLabel?: string;
  /** Custom class merged with `.cinder-sparkbar`. */
  class?: string;
};

/** The bar arm: a bounded value as a labeled meter. This is the default. */
export type SparkbarBarProps = SparkbarSharedProps & {
  /** Current bounded value. */
  value: number;
  /** Upper bound for the range. Defaults to `1` for fractional values. */
  max?: number;
  /** Visible label for the measured row. */
  label: string;
  /** Optional trailing value such as a cost, token count, or percentage. */
  trailing?: string;
  /** Fill color intent. Default `accent`. */
  variant?: SparkbarVariant;
  /** Accessible value text override. Defaults to the trimmed trailing value when provided. */
  ariaValueText?: string;
  points?: undefined;
  startLabel?: undefined;
  endLabel?: undefined;
};

/**
 * The line arm: a trend drawn as a thin line over a baseline, with a dot on its latest value and
 * an optional label at each end of the axis. It is chosen by passing `points`.
 */
export type SparkbarLineProps = SparkbarSharedProps & {
  /**
   * The series, oldest first, drawn left to right on a scale from its lowest to its highest value.
   * Values that are not finite are skipped. Fewer than two usable values draw only the baseline.
   */
  points: number[];
  /** What the line shows, as a full sentence ("Storage use over the last 24 hours, rising to 1.6 GB"). It is the accessible name of the line, which is an image, and is not drawn. */
  label: string;
  /** Text under the left end of the baseline, such as "1.4 GB · 24 hours ago". */
  startLabel?: string;
  /** Text under the right end of the baseline, such as "Now". */
  endLabel?: string;
  value?: undefined;
  max?: undefined;
  trailing?: undefined;
  variant?: undefined;
  ariaValueText?: undefined;
};

/** Props for the Sparkbar component: a labeled bounded meter, or, with `points`, a trend line. */
export type SparkbarProps = SparkbarBarProps | SparkbarLineProps;

/** Schema generator surface for JSON-safe Sparkbar props. */
export type SparkbarSchemaProps = {
  /** Current bounded value. Required for a bar; omit it when `points` is given. */
  value?: number;
  /** Upper bound for the range. Defaults to `1` for fractional values. */
  max?: number;
  /** Visible label for a bar. For a line (when `points` is given) it is the accessible name and is not drawn. */
  label: string;
  /** Optional trailing value such as a cost, token count, or percentage. */
  trailing?: string;
  /** Track thickness and text scale. Default `md`. For a line, the height of the plot: 3rem, 6rem or 8rem. */
  size?: SparkbarSize;
  /** Fill color intent. Default `accent`. */
  variant?: SparkbarVariant;
  /** Draws a trend line instead of a bar: the series, oldest first, on a scale from its lowest to its highest value. Values that are not finite are skipped. */
  points?: number[];
  /** Line only: text under the left end of the baseline, such as "1.4 GB · 24 hours ago". */
  startLabel?: string;
  /** Line only: text under the right end of the baseline, such as "Now". */
  endLabel?: string;
  /** Partial visual theme override. Omitted fields inherit the surrounding application. */
  theme?: ChartThemeSchema;
  /** Accessible name override. Defaults to `${label}, ${percentage}%` for a bar, and to `label` for a line. */
  ariaLabel?: string;
  /** Accessible value text override. Defaults to the trimmed trailing value when provided. */
  ariaValueText?: string;
  /** Custom class merged with `.cinder-sparkbar`. */
  class?: string;
};
