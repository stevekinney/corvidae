/**
 * COR-851 — the cost estimator a goal attempt's run was started with, as it is
 * persisted beside the run's recovery record.
 *
 * An attempt is priced after it ends, possibly in another process and against a
 * catalog that has since moved to another revision of the agent or dropped it.
 * The estimator is therefore not re-resolved then: the start records the exact
 * `RunOptions.costEstimation` the run was configured with (`null` for none,
 * which is a selection, not an absence), and every later pricing reads that.
 *
 * The record is plain JSON on purpose, so it round-trips exactly. The same
 * check guards the write and the decode, so a value the decoder would refuse is
 * never written.
 */

import type { RunOptions } from '@lostgradient/operative';

/** The persisted selection: the run's estimator, or `null` when it declared none. */
export type GoalAttemptCostEstimation = NonNullable<RunOptions['costEstimation']> | null;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const PRICE_KEYS = [
  'promptCostPerMillionTokens',
  'completionCostPerMillionTokens',
  'cacheWriteCostPerMillionTokens',
  'cacheReadCostPerMillionTokens',
];

/** The rates of one tier: the two required prices and the optional cache prices, and nothing else. */
function hasValidRates(value: Record<string, unknown>, extraKeys: readonly string[]): boolean {
  if (!Object.keys(value).every((key) => PRICE_KEYS.includes(key) || extraKeys.includes(key))) {
    return false;
  }
  if (!isPrice(value['promptCostPerMillionTokens'])) return false;
  if (!isPrice(value['completionCostPerMillionTokens'])) return false;
  return ['cacheWriteCostPerMillionTokens', 'cacheReadCostPerMillionTokens'].every(
    (key) => value[key] === undefined || isPrice(value[key]),
  );
}

function isModelPricing(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (!hasValidRates(value, ['longContext'])) return false;
  // COR-1914: a file agent's budget prices a long-prompt tier from the catalog row, and the
  // estimator persisted for a goal attempt must keep it, or the attempt would not start.
  const longContext = value['longContext'];
  if (longContext === undefined) return true;
  return (
    isPlainRecord(longContext) &&
    hasValidRates(longContext, ['inputTokensAbove']) &&
    isPrice(longContext['inputTokensAbove'])
  );
}

/** Whether `value` is a persistable selection: `null`, or `{ model, pricing? }` with plain-JSON prices. */
export function isGoalAttemptCostEstimation(value: unknown): value is GoalAttemptCostEstimation {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  if (!Object.keys(value).every((key) => key === 'model' || key === 'pricing')) return false;
  if (typeof value['model'] !== 'string' || value['model'].length === 0) return false;
  const pricing = value['pricing'];
  if (pricing === undefined) return true;
  if (!isPlainRecord(pricing)) return false;
  if (!Object.keys(pricing).every((key) => key === 'customPricing')) return false;
  const custom = pricing['customPricing'];
  return (
    custom === undefined ||
    (isPlainRecord(custom) &&
      // `null` is a model the catalog has no price for (COR-1921), which a budgeted agent states.
      Object.values(custom).every((entry) => entry === null || isModelPricing(entry)))
  );
}
