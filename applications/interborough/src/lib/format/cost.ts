/**
 * What a run cost, in words (COR-2525). The Bureau reports a run's cost in US dollars, and `null`
 * when no request was priced from the model catalog: unknown, never free. So the formatter has no
 * value for a run with no cost, and a caller leaves the cost out instead of printing `$0.00`.
 *
 * @module cost
 */
import { COST_COPY } from '../../app/copy/cost.ts';

/** One cent, in dollars: an amount below it is said as {@link COST_COPY.underOneCent}. */
const ONE_CENT = 0.01;

const DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A run's cost as a person reads it: `< $0.01` under one cent, and otherwise dollars with two
 * decimals (`$0.12`, `$1,204.50`). `undefined` for a cost the run does not have (`null` or absent)
 * and for a figure that is not a finite amount of money, so the caller shows nothing.
 */
export function formatCost(costUsd: number | null | undefined): string | undefined {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
    return undefined;
  }
  return costUsd < ONE_CENT ? COST_COPY.underOneCent : DOLLARS.format(costUsd);
}

/** What a goal's attempts cost together: the sum of those that have a cost, and whether some had none. */
export type AttemptsCost = {
  /** The sum of the attempts that have a cost, in US dollars. */
  readonly costUsd: number;
  /** `true` when at least one attempt has no cost, so the sum is only part of what the goal cost. */
  readonly partial: boolean;
};

/**
 * The cost of a goal from its attempts: the sum of the attempts that have one, marked partial when
 * any attempt has none, and `null` when no attempt has one (or the goal has made no attempt).
 */
export function attemptsCost(
  attempts: readonly { readonly usage: { readonly costUsd: number | null } }[],
): AttemptsCost | null {
  let total = 0;
  let priced = 0;
  for (const attempt of attempts) {
    const cost = attempt.usage.costUsd;
    if (cost === null || !Number.isFinite(cost) || cost < 0) continue;
    total += cost;
    priced += 1;
  }
  if (priced === 0) return null;
  return { costUsd: total, partial: priced < attempts.length };
}

/** A goal's cost as its row says it: the amount, and "At least" before it when it is partial. */
export function formatAttemptsCost(cost: AttemptsCost | null): string | undefined {
  if (cost === null) return undefined;
  const amount = formatCost(cost.costUsd);
  if (amount === undefined) return undefined;
  return cost.partial ? COST_COPY.atLeast(amount) : amount;
}
