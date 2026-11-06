import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { ChartTheme, ChartThemeSchema } from '../chart.types.ts';
/** Direction of a stat change indicator. */
export type StatisticChangeDirection = 'up' | 'down' | 'neutral';
/** Data for the optional change indicator rendered below the stat value. */
export type StatisticChange = {
  /** The change magnitude as a display string, e.g. "4.75%", "+$120", "12". */
  value: string;
  /** Direction of change — drives icon + color. */
  direction: StatisticChangeDirection;
  /** Optional visible description, e.g. "from last month". Rendered aria-hidden. */
  description?: string;
  /**
   * Optional fully-worded accessible label for the change indicator.
   * When omitted, a phrase is synthesized from `direction` + `value` (+ optional `description`).
   * When provided, used verbatim — the caller owns the full wording.
   */
  label?: string;
};
export type StatisticProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Short label describing the metric, e.g. "Monthly Revenue". */
  label: string;
  /** The statistic. Strings rendered verbatim; numbers formatted via formatNumber. */
  value: string | number;
  /** Draws an amber attention dot before the label. Set it only when the value is a non-zero bad count (such as missed runs or items waiting on you), never on a zero or a healthy count. The dot is decorative: the label wording carries the meaning. */
  attention?: boolean;
  /** A short muted line under the value that says what it means in words, such as "Nothing is running", "An approval and a question" or "3 done · 2 waiting on you". It describes the group for assistive technology, so state it as a sentence fragment that stands on its own. */
  caption?: string;
  /** Draws a placeholder block where the value goes, for a statistic whose number has not been read yet, so the tile keeps its size when the number arrives. The tile is marked busy, and `value` is not shown or announced while it is set. */
  loading?: boolean;
  /** Optional change indicator with direction and accessible wording. */
  change?: StatisticChange;
  /** Partial visual theme override. Omitted fields inherit the surrounding application. */
  theme?: ChartTheme;
  /** Optional leading icon snippet (decorative — wrapper is aria-hidden). */
  icon?: Snippet;
  /** Intl.NumberFormat options applied only when `value` is a number. */
  valueFormatOptions?: Intl.NumberFormatOptions;
  /** Locale forwarded to formatNumber. Defaults to the nearest LocaleProvider locale, then en-US. */
  valueLocale?: string;
  /** Additional class names merged with `.cinder-statistic`. */
  class?: string;
};

/** Schema generator surface for Statistic — excludes native attributes except supported styling hooks. */
export interface StatisticSchemaProps {
  /** Short label describing the metric, e.g. "Monthly Revenue". */
  label: string;
  /** The statistic. Strings rendered verbatim; numbers formatted via formatNumber. */
  value: string | number;
  /** Draws an amber attention dot before the label. Set it only when the value is a non-zero bad count (such as missed runs or items waiting on you), never on a zero or a healthy count. The dot is decorative: the label wording carries the meaning. */
  attention?: boolean;
  /** A short muted line under the value that says what it means in words, such as "Nothing is running", "An approval and a question" or "3 done · 2 waiting on you". It describes the group for assistive technology, so state it as a sentence fragment that stands on its own. */
  caption?: string;
  /** Draws a placeholder block where the value goes, for a statistic whose number has not been read yet, so the tile keeps its size when the number arrives. The tile is marked busy, and `value` is not shown or announced while it is set. */
  loading?: boolean;
  /** Optional change indicator with direction and accessible wording. */
  change?: StatisticChange;
  /** Partial visual theme override. Omitted fields inherit the surrounding application. */
  theme?: ChartThemeSchema;
  /** Optional leading icon snippet (decorative — wrapper is aria-hidden). */
  icon?: Snippet;
  /** Intl.NumberFormat options applied only when `value` is a number. */
  valueFormatOptions?: Intl.NumberFormatOptions;
  /** Locale forwarded to formatNumber. Defaults to the nearest LocaleProvider locale, then en-US. */
  valueLocale?: string;
  /** Additional class names merged with `.cinder-statistic`. */
  class?: string;
  /** Inline style string applied to the `.cinder-statistic` root. */
  style?: string;
}
