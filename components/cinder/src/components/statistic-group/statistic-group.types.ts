import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
/** Number of columns in the stat grid, or 'auto' for responsive auto-fit. */
export type StatisticGroupColumns = 1 | 2 | 3 | 4 | 'auto';
/**
 * The one edge a `cards` stat draws: a hairline `border` with no shadow, or a soft `shadow` over the
 * border. It only changes the `cards` variant, the one that gives each stat a card of its own.
 */
export type StatisticGroupEdge = 'border' | 'shadow';
/** Visual variant for the stat group container. */
export type StatisticGroupVariant = 'default' | 'cards' | 'shared-borders';
export type StatisticGroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /**
   * Optional accessible label for the whole stat set. When provided, the
   * container becomes `role="group"` and uses this value as its accessible name.
   */
  label?: string;
  /**
   * Grid column count. `'auto'` uses auto-fit with minmax for responsive layout.
   * @default 'auto'
   */
  columns?: StatisticGroupColumns;
  /**
   * Visual variant; surfaced as `data-cinder-variant` for CSS styling.
   * - `'default'` — a bordered resting surface, with dividers between stats when
   *   `columns` is a fixed count. `columns='auto'` has no dividers: an auto-fit grid's
   *   column count is unbounded, so CSS cannot tell which cells end a row.
   * - `'cards'` — each stat gets a card-style border and shadow.
   * - `'shared-borders'` — single outer border with 1px gap dividers between stats.
   * @default 'default'
   */
  variant?: StatisticGroupVariant;
  /**
   * With `variant="cards"`, the edge each stat's card draws: a flat `'border'`, or a `'shadow'` over
   * the border, as a raised card has. The other variants have their own borders and ignore it.
   * @default 'shadow'
   */
  edge?: StatisticGroupEdge;
  /** Statistic children, typically one or more `<Statistic>` components. */
  children: Snippet;
  /** Additional class names merged with `.cinder-statistic-group`. */
  class?: string;
};

/** Schema generator surface for StatisticGroup — excludes native attributes except supported styling hooks. */
export interface StatisticGroupSchemaProps {
  /**
   * Optional accessible label for the whole stat set. When provided, the
   * container becomes `role="group"` and uses this value as its accessible name.
   */
  label?: string;
  /**
   * Grid column count. `'auto'` uses auto-fit with minmax for responsive layout.
   * @default 'auto'
   */
  columns?: StatisticGroupColumns;
  /**
   * Visual variant; surfaced as `data-cinder-variant` for CSS styling.
   * - `'default'` — a bordered resting surface, with dividers between stats when
   *   `columns` is a fixed count. `columns='auto'` has no dividers: an auto-fit grid's
   *   column count is unbounded, so CSS cannot tell which cells end a row.
   * - `'cards'` — each stat gets a card-style border and shadow.
   * - `'shared-borders'` — single outer border with 1px gap dividers between stats.
   * @default 'default'
   */
  variant?: StatisticGroupVariant;
  /**
   * With `variant="cards"`, the edge each stat's card draws: a flat `'border'`, or a `'shadow'` over
   * the border, as a raised card has. The other variants have their own borders and ignore it.
   * @default 'shadow'
   */
  edge?: StatisticGroupEdge;
  /** Statistic children, typically one or more `<Statistic>` components. */
  children: Snippet;
  /** Additional class names merged with `.cinder-statistic-group`. */
  class?: string;
  /** Inline style string applied to the `.cinder-statistic-group` root. */
  style?: string;
}
