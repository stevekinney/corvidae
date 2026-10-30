/**
 * A run's own dollar budget (COR-1914): the spend a single run may reach, and the fractions of it
 * that warn first.
 *
 * It reads `RunState.cost`, the per-request cost a run already accumulates for its terminal
 * `costEstimate` and a durable run checkpoints in its cursor. Reading that, rather than keeping a
 * counter of its own, makes the budget per run by construction and keeps it across a recovery: a
 * resumed run starts from the cursor's cost, so a threshold it already crossed is behind it and is
 * not announced again. {@link createCostBudgetMonitor} is the other way to stop on spend; it is a
 * stop condition, which every run of an agent shares and which finishes a run with
 * `stop-condition`, so it can answer neither of those.
 *
 * @module cost-budget
 */

import type { AccumulatedCost } from './cost-estimation';

/** The most thresholds a {@link RunCostBudget} may list in `warnAt`. */
export const RUN_COST_BUDGET_MAXIMUM_WARNINGS = 10;

/**
 * What one run of an agent may spend, in US dollars. It is measured against the run's own cost
 * estimate, which prices each request at its model's rate (`RunOptions.costEstimation`), so a run
 * can only have a budget when it can be priced: {@link validateRunCostBudget} says so.
 */
export interface RunCostBudget {
  /** The spend, in US dollars, at which the run ends with the finish reason `budget-exceeded`. */
  readonly perRunUsd: number;
  /**
   * Fractions of `perRunUsd`, each strictly between 0 and 1, at which the run publishes one
   * `budget.threshold` event. A fraction is announced once per run, including across a recovery.
   * Absent or empty, the run warns at none.
   */
  readonly warnAt?: readonly number[] | undefined;
}

/** The sum of the cost components a run has accumulated; `0` for a run with no priced request. */
export function totalAccumulatedCost(cost: AccumulatedCost | undefined): number {
  if (cost === undefined) return 0;
  return cost.promptCost + cost.completionCost + cost.cacheWriteCost + cost.cacheReadCost;
}

/**
 * The `warnAt` thresholds a step's spend crossed: those at or below the cost after the step and
 * above the cost before it, ascending. Because a run's cost only rises and a recovered run starts
 * from its checkpointed cost, each threshold falls in exactly one step's range.
 */
export function crossedThresholds(
  budget: RunCostBudget,
  costBefore: number,
  costAfter: number,
): number[] {
  const crossed: number[] = [];
  for (const threshold of [...(budget.warnAt ?? [])].toSorted((a, b) => a - b)) {
    const limit = threshold * budget.perRunUsd;
    if (costBefore < limit && costAfter >= limit) crossed.push(threshold);
  }
  return crossed;
}

/** Whether the run has spent its whole budget. */
export function isRunCostBudgetExceeded(budget: RunCostBudget, cost: number): boolean {
  return cost >= budget.perRunUsd;
}

/** Why a {@link RunCostBudget} cannot be used, or `undefined` when it can. */
export function validateRunCostBudget(budget: RunCostBudget): string | undefined {
  if (!Number.isFinite(budget.perRunUsd) || budget.perRunUsd <= 0) {
    return 'costBudget.perRunUsd must be a positive, finite number of US dollars.';
  }
  const warnAt = budget.warnAt ?? [];
  if (warnAt.length > RUN_COST_BUDGET_MAXIMUM_WARNINGS) {
    return `costBudget.warnAt may list at most ${RUN_COST_BUDGET_MAXIMUM_WARNINGS} thresholds.`;
  }
  if (warnAt.some((threshold) => !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1)) {
    return 'costBudget.warnAt must list fractions strictly between 0 and 1.';
  }
  return undefined;
}
