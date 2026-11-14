import type { TokenUsage } from './types';

/**
 * Per-model pricing used by {@link estimateCost}.
 *
 * `cacheWriteCostPerMillionTokens` and `cacheReadCostPerMillionTokens` price
 * `TokenUsage.cacheCreationTokens`/`cacheReadTokens` at their own rates —
 * omitted for models/providers with no native cache pricing, in which case
 * any cache token counts on the usage are priced at `0` (see {@link estimateCost}).
 */
export interface ModelPricing {
  promptCostPerMillionTokens: number;
  completionCostPerMillionTokens: number;
  /** Price for tokens written to the prompt cache. Anthropic only. */
  cacheWriteCostPerMillionTokens?: number | undefined;
  /** Price for tokens served from the prompt cache. */
  cacheReadCostPerMillionTokens?: number | undefined;
  /**
   * Rates for a single request whose total input (fresh prompt plus cache reads and writes)
   * exceeds `inputTokensAbove`. Applied only to request-scoped estimates; see {@link estimateCost}.
   */
  longContext?: LongContextPricing | undefined;
}

/** A model's higher price tier for long prompts, replacing every rate above the threshold. */
export interface LongContextPricing extends Omit<ModelPricing, 'longContext'> {
  inputTokensAbove: number;
}

/**
 * Whether a usage describes one request (`'request'`, the default) or a sum over many
 * (`'aggregate'`). Long-prompt tiers are decided per request, so an aggregate is always priced at
 * the base tier: a run of many short requests must not be billed as one long one.
 */
export type CostEstimationScope = 'request' | 'aggregate';

export interface CostEstimate {
  promptCost: number;
  completionCost: number;
  /** Cost attributed to `usage.cacheCreationTokens`. `0` when absent or unpriced. */
  cacheWriteCost: number;
  /** Cost attributed to `usage.cacheReadTokens`. `0` when absent or unpriced. */
  cacheReadCost: number;
  totalCost: number;
  model: string;
  usage: TokenUsage;
}

/**
 * The per-component cost of every request a run has made so far, each priced on its own usage
 * (see {@link accumulateRequestCost}). Plain numbers, so a run's state can be checkpointed.
 */
export interface AccumulatedCost {
  promptCost: number;
  completionCost: number;
  cacheWriteCost: number;
  cacheReadCost: number;
}

export interface CostEstimationOptions {
  /**
   * Prices by model name: Operative holds none of its own, so a model is priced only when named
   * here (a host prices from its catalog rows, COR-1921). A name set to `null` states that the
   * model has no price. `null`, not `undefined`, so the statement survives JSON.
   */
  customPricing?: Record<string, ModelPricing | null> | undefined;
}

/**
 * Estimate a prompt-cache hit rate from a {@link TokenUsage}.
 *
 * `cacheReadTokens / (cacheReadTokens + cacheCreationTokens + prompt)` — the
 * fraction of this request's non-completion input that was served from the
 * cache rather than written fresh or sent uncached. Returns `undefined` when
 * the usage carries no cache signal at all (`cacheReadTokens` and
 * `cacheCreationTokens` both absent), so "no data" is never confused with
 * "0% hit rate". A request that only ever writes to the cache (first turn,
 * `cacheReadTokens` absent, `cacheCreationTokens` present) correctly reports
 * `0`.
 */
export function estimateCacheHitRate(usage: TokenUsage): number | undefined {
  if (usage.cacheReadTokens === undefined && usage.cacheCreationTokens === undefined) {
    return undefined;
  }

  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const denominator = cacheReadTokens + cacheCreationTokens + usage.prompt;

  return denominator === 0 ? 0 : cacheReadTokens / denominator;
}

/**
 * The `customPricing` key that prices a model as one provider serves it (COR-1921). Two providers
 * can serve a model of the same name at different prices, or one of them at none, and a session
 * switched to a model names its provider when the caller did. A host that prices from a catalog
 * sets this key for each row; a step that names a provider reads it before the bare model name.
 */
export function providerModelPricingKey(provider: string, model: string): string {
  // A pair, not a joined string: a gateway row named `anthropic/claude-opus-5` and the
  // `claude-opus-5` row of the `anthropic` provider must not share a key.
  return JSON.stringify([provider, model]);
}

export function getModelPricing(
  model: string,
  options?: CostEstimationOptions,
): ModelPricing | undefined {
  const custom = options?.customPricing;
  if (custom === undefined || !Object.hasOwn(custom, model)) return undefined;
  return custom[model] ?? undefined;
}

/**
 * Estimate the cost of a {@link TokenUsage} at a model's {@link ModelPricing}.
 *
 * **This estimate is for in-loop budgeting only — never for billing.** It is
 * computed from a static, hand-maintained pricing table that can drift from a
 * provider's actual invoiced rates (promotional pricing, volume discounts,
 * batch-API pricing, mid-cycle price changes). Use it to drive
 * {@link createCostBudgetMonitor} and similar in-loop stop conditions, never
 * as a source of truth for what a run actually cost.
 *
 * Cache tokens are priced at their own rate when the model's pricing defines
 * one; when `usage.cacheCreationTokens`/`cacheReadTokens` are present but the
 * model has no cache pricing, those tokens cost `0` (they're not silently
 * folded into the prompt rate).
 */
export function estimateCost(
  usage: TokenUsage,
  model: string,
  options?: CostEstimationOptions,
  scope: CostEstimationScope = 'request',
): CostEstimate {
  const pricing = getModelPricing(model, options);
  if (!pricing) {
    throw new Error(`No pricing found for model: ${model}`);
  }

  const inputTokens =
    usage.prompt + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const rates =
    scope === 'request' && pricing.longContext && inputTokens > pricing.longContext.inputTokensAbove
      ? pricing.longContext
      : pricing;

  const promptCost = (usage.prompt / 1_000_000) * rates.promptCostPerMillionTokens;
  const completionCost = (usage.completion / 1_000_000) * rates.completionCostPerMillionTokens;
  const cacheWriteCost =
    usage.cacheCreationTokens !== undefined && rates.cacheWriteCostPerMillionTokens !== undefined
      ? (usage.cacheCreationTokens / 1_000_000) * rates.cacheWriteCostPerMillionTokens
      : 0;
  const cacheReadCost =
    usage.cacheReadTokens !== undefined && rates.cacheReadCostPerMillionTokens !== undefined
      ? (usage.cacheReadTokens / 1_000_000) * rates.cacheReadCostPerMillionTokens
      : 0;

  return {
    promptCost,
    completionCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: promptCost + completionCost + cacheWriteCost + cacheReadCost,
    model,
    usage,
  };
}

/**
 * Price usage whose per-request breakdown is unknown — a checkpoint written before costs were
 * accumulated — at the base tier, the best estimate available for it. Returns `undefined` for
 * no usage or an unpriced model.
 */
export function seedAccumulatedCost(
  prior: TokenUsage,
  model: string,
  options?: CostEstimationOptions,
): AccumulatedCost | undefined {
  const hasUsage =
    prior.prompt > 0 ||
    prior.completion > 0 ||
    (prior.cacheCreationTokens ?? 0) > 0 ||
    (prior.cacheReadTokens ?? 0) > 0;
  if (!hasUsage || !getModelPricing(model, options)) return undefined;
  const { promptCost, completionCost, cacheWriteCost, cacheReadCost } = estimateCost(
    prior,
    model,
    options,
    'aggregate',
  );
  return { promptCost, completionCost, cacheWriteCost, cacheReadCost };
}

/**
 * Add one request's cost to a run's {@link AccumulatedCost}. The request is priced on its own
 * usage, so a long-prompt tier applies to exactly the requests that crossed its threshold, never
 * to a sum of many short ones. Returns `current` unchanged when the model has no pricing.
 */
export function accumulateRequestCost(
  current: AccumulatedCost | undefined,
  usage: TokenUsage,
  model: string,
  options?: CostEstimationOptions,
): AccumulatedCost | undefined {
  if (!getModelPricing(model, options)) return current;
  const request = estimateCost(usage, model, options, 'request');
  return {
    promptCost: (current?.promptCost ?? 0) + request.promptCost,
    completionCost: (current?.completionCost ?? 0) + request.completionCost,
    cacheWriteCost: (current?.cacheWriteCost ?? 0) + request.cacheWriteCost,
    cacheReadCost: (current?.cacheReadCost ?? 0) + request.cacheReadCost,
  };
}
