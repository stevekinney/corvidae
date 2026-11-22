/**
 * The words that say what a run cost (COR-2525), wherever a cost is shown: reply details, the Run
 * page, the Runs list, a goal's row, and the command line. One amount is written one way in all of
 * them, and a run that has no cost says nothing: there is no "$0.00" and no dash for it.
 */
export const COST_COPY = {
  /** The label beside a cost: a reply's usage, the Run page's facts, and the command line. */
  label: 'Cost',
  /** The Runs list's Cost column, which names itself for assistive technology. */
  column: 'Cost',
  /** What an amount under one cent says. */
  underOneCent: '< $0.01',
  /**
   * A goal's cost when at least one of its attempts has none: the sum of the attempts that do, said
   * as a floor, so it is never read as the whole goal's cost.
   */
  atLeast: (amount: string): string => `At least ${amount}`,
  /** The tooltip of a goal's cost that is only part of the whole. */
  partialNote: 'Not every attempt has a cost, so this is the sum of those that do.',
  /** The accessible name of a run's cost on a row. */
  rowLabel: (amount: string): string => `Cost ${amount}`,
} as const;
