/**
 * Applying a run's `costBudget` around one step (COR-1914).
 *
 * The check compares the run's spend before the step began with its spend when the step ends, so
 * everything the step folded into `RunState.cost` is counted: the response it kept, and a billed
 * response it discarded (a failed generate, a step an `onError` hook skipped, a step that was
 * aborted). A step that reaches finalization is checked there, once its stop conditions are about
 * to run; a step that ends before then is checked by {@link runStep}'s wrapper.
 *
 * @module run-step-cost-budget
 */

import {
  crossedThresholds,
  isChatCostBudgetExhausted,
  isRunCostBudgetExceeded,
  totalAccumulatedCost,
} from './cost-budget';
import { BudgetExceededError } from './errors';
import { BudgetThresholdEvent } from './events';
import type { EventDispatcher, RunState, StepDeps } from './run-step';
import { type SteeredModel, switchedPricingKey } from './run-step-support';

/** What one step needs to check the budget: the spend it began with, and whether it has been checked. */
export interface StepCostWindow {
  /** The run's spend, in US dollars, when the step began. */
  readonly before: number;
  /** The model the step's requests are priced at; `undefined` when the run prices nothing. */
  model: string | undefined;
  /** Whether the budget has been applied to this step, so no fraction is announced twice. */
  checked: boolean;
}

/** Opens the window for a step that is about to begin. */
export function openStepCostWindow(runState: RunState): StepCostWindow {
  return { before: totalAccumulatedCost(runState.cost), model: undefined, checked: false };
}

/**
 * Publishes a `budget.threshold` event for each `warnAt` fraction the step's spend crossed, then
 * throws a {@link BudgetExceededError} naming `perRunUsd` when the run has spent the whole budget.
 * It reads `runState.cost`, which a durable run keeps in its cursor, so a recovered run counts
 * what it spent before the restart. Does nothing for a run with no budget or nothing to price it
 * with, and does nothing the second time it is asked about the same step.
 */
export function checkCostBudget(input: {
  deps: StepDeps;
  runState: RunState;
  emitter: EventDispatcher | undefined;
  step: number;
  window: StepCostWindow;
}): void {
  const { deps, runState, emitter, step, window } = input;
  if (window.checked) return;
  window.checked = true;
  const budget = deps.costBudget;
  if (budget === undefined || window.model === undefined) return;
  const costAfter = totalAccumulatedCost(runState.cost);
  for (const threshold of crossedThresholds(budget, window.before, costAfter)) {
    emitter?.dispatch(
      new BudgetThresholdEvent(
        { threshold, currentCost: costAfter, budget: budget.perRunUsd, model: window.model },
        step,
      ),
    );
  }
  if (isRunCostBudgetExceeded(budget, costAfter)) {
    throw new BudgetExceededError(
      `The run spent $${costAfter.toFixed(6)}, which reached its cost budget (perRunUsd: $${budget.perRunUsd}).`,
    );
  }
}

/**
 * Throws a {@link BudgetExceededError} naming the model when a run with a cost budget is about to
 * take a step on a model its pricing does not know (COR-1921). A session can be switched to
 * another model between steps; the step must cost what that model charges, and counting it at
 * another model's rate would let the run spend past its budget unseen. The run stops before the
 * step asks the model anything. A run with no budget, or no `costEstimation`, is never stopped by
 * this, and neither is a step on the model the run's pricing was built for.
 */
export function checkSwitchedModelPriced(deps: StepDeps, steered: SteeredModel | undefined): void {
  const budget = deps.costBudget;
  const { costEstimation } = deps;
  if (budget === undefined || costEstimation === undefined || steered?.model === undefined) return;
  if (switchedPricingKey(costEstimation, steered) !== undefined) return;
  const served =
    steered.modelProvider === undefined
      ? `"${steered.model}"`
      : `"${steered.model}" from "${steered.modelProvider}"`;
  throw new BudgetExceededError(
    `The run was switched to the model ${served}, which has no price, so its spend cannot be counted against the run's cost budget (perRunUsd: $${budget.perRunUsd}).`,
  );
}

/**
 * Throws a {@link BudgetExceededError} naming `perChatUsd` when the chat the run belongs to had
 * already spent its budget before the run began (COR-1915). It is asked once, before the run's
 * first step: a run that is under way, or one recovered past its first step, is never stopped by
 * what its siblings spent meanwhile, so the run that crosses the limit finishes and the one after
 * it is the one that stops.
 */
export function checkChatCostBudget(deps: StepDeps): void {
  const budget = deps.costBudget;
  if (budget === undefined || !isChatCostBudgetExhausted(budget)) return;
  throw new BudgetExceededError(
    `The chat had spent $${(budget.priorChatSpendUsd ?? 0).toFixed(6)}, which reached its cost budget (perChatUsd: $${budget.perChatUsd}), so this run did not start.`,
  );
}
