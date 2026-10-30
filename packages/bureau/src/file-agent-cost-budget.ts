/**
 * What a file agent's `costBudget` needs from the model catalog (COR-1914): the prices that turn a
 * run's token usage into dollars.
 *
 * The budget is measured against Operative's per-run cost estimate, which prices each request at
 * its model's rate. The rates come from the catalog's own price rows, so the budget follows the
 * deployment's catalog and not Operative's built-in table. A row prices a model in US dollars per
 * million input and output tokens, and says nothing about prompt caching; where Operative's table
 * knows the model, its cache rates are kept, so a run that reads a cache is not priced as if the
 * cache were free.
 *
 * @module file-agent-cost-budget
 */

import {
  type BackendDescriptor,
  type CostEstimationOptions,
  getModelPricing,
  type ModelPricing,
  type RunCostBudget,
  type RunOptions,
} from '@lostgradient/operative';

import type { AgentCostBudget, AgentToolBudget } from './agent-file';

/**
 * The price of a catalog row as Operative prices a request, or `undefined` when the row has no
 * price in US dollars. A row priced in another currency is unpriced here: a dollar limit cannot be
 * measured in it.
 */
export function usdPricingOfRow(row: BackendDescriptor): ModelPricing | undefined {
  const price = row.pricing;
  if (price === undefined || price.currency.toUpperCase() !== 'USD') return undefined;
  // Operative's table, when it knows the model, supplies the cache rates the catalog row lacks.
  const known = getModelPricing(row.model);
  const longContext = price.longContext;
  return {
    ...(known?.cacheWriteCostPerMillionTokens === undefined
      ? {}
      : { cacheWriteCostPerMillionTokens: known.cacheWriteCostPerMillionTokens }),
    ...(known?.cacheReadCostPerMillionTokens === undefined
      ? {}
      : { cacheReadCostPerMillionTokens: known.cacheReadCostPerMillionTokens }),
    promptCostPerMillionTokens: price.inputPerMillionTokens,
    completionCostPerMillionTokens: price.outputPerMillionTokens,
    ...(longContext === undefined
      ? {}
      : {
          longContext: {
            ...(known?.longContext?.cacheWriteCostPerMillionTokens === undefined
              ? {}
              : {
                  cacheWriteCostPerMillionTokens: known.longContext.cacheWriteCostPerMillionTokens,
                }),
            ...(known?.longContext?.cacheReadCostPerMillionTokens === undefined
              ? {}
              : { cacheReadCostPerMillionTokens: known.longContext.cacheReadCostPerMillionTokens }),
            inputTokensAbove: longContext.inputTokensAbove,
            promptCostPerMillionTokens: longContext.inputPerMillionTokens,
            completionCostPerMillionTokens: longContext.outputPerMillionTokens,
          },
        }),
  };
}

/**
 * The `costBudget` and `costEstimation` a file agent is built with. `descriptor` is the agent's
 * default model, which must be priced; `allowed` are the rows a session may switch it to, whose
 * prices are included so a step on a switched model is counted at that model's rate. A switched
 * model with no price is counted at the default model's rate.
 */
export function costBudgetOptions(
  budget: AgentCostBudget,
  descriptor: BackendDescriptor,
  allowed: readonly BackendDescriptor[],
): Pick<RunOptions, 'costBudget' | 'costEstimation'> {
  const customPricing: NonNullable<CostEstimationOptions['customPricing']> = {};
  const defaultPricing = usdPricingOfRow(descriptor);
  for (const row of [descriptor, ...allowed]) {
    // The default model first, so a second provider serving a model of the same name never
    // changes what the default is counted at.
    if (Object.hasOwn(customPricing, row.model)) continue;
    // A row with no USD price is counted at the default model's rate. It is entered explicitly:
    // left out, a model Operative's built-in table happens to know would be counted at that
    // table's rate instead, which is neither the catalog's nor the documented fallback.
    const pricing = usdPricingOfRow(row) ?? defaultPricing;
    if (pricing !== undefined) customPricing[row.model] = pricing;
  }
  const runBudget: RunCostBudget = {
    perRunUsd: budget.perRunUsd,
    // The chat's earlier spend is not known to an agent, only to the Bureau that starts a chat's
    // run: it passes it as `priorChatSpendUsd` (`chat-spend-ledger.ts`).
    ...(budget.perChatUsd === undefined ? {} : { perChatUsd: budget.perChatUsd }),
    ...(budget.warnAt === undefined ? {} : { warnAt: [...budget.warnAt] }),
  };
  return {
    costBudget: runBudget,
    costEstimation: { model: descriptor.model, pricing: { customPricing } },
  };
}

/**
 * A file's `toolBudget` as Armorer's `ToolboxOptions.budget` states it (COR-1915): seconds become
 * milliseconds, and a limit the file leaves out is left out.
 */
export function toolboxBudgetOf(budget: AgentToolBudget): {
  maxCalls?: number;
  maxDurationMs?: number;
} {
  return {
    ...(budget.maxCalls === undefined ? {} : { maxCalls: budget.maxCalls }),
    ...(budget.maxDurationSeconds === undefined
      ? {}
      : { maxDurationMs: Math.ceil(budget.maxDurationSeconds * 1000) }),
  };
}
