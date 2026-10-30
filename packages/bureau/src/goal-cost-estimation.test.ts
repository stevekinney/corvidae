import { createModelCatalog } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { costBudgetOptions } from './file-agent-cost-budget';
import { isGoalAttemptCostEstimation } from './goal-cost-estimation';

describe('isGoalAttemptCostEstimation', () => {
  it.each([
    null,
    { model: 'gpt-4o' },
    { model: 'x', pricing: {} },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: {
            promptCostPerMillionTokens: 1,
            completionCostPerMillionTokens: 2,
            cacheReadCostPerMillionTokens: 0.1,
          },
        },
      },
    },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: {
            promptCostPerMillionTokens: 1,
            completionCostPerMillionTokens: 2,
            longContext: {
              inputTokensAbove: 200_000,
              promptCostPerMillionTokens: 2,
              completionCostPerMillionTokens: 4,
              cacheReadCostPerMillionTokens: 0.2,
            },
          },
        },
      },
    },
  ])('accepts a plain-JSON selection: %j', (value) => {
    expect(isGoalAttemptCostEstimation(value)).toBe(true);
    expect(isGoalAttemptCostEstimation(JSON.parse(JSON.stringify(value)))).toBe(true);
  });

  it.each([
    'gpt-4o',
    ['model'],
    {},
    { model: '' },
    { model: 7 },
    { model: 'x', extra: true },
    { model: 'x', pricing: 'cheap' },
    { model: 'x', pricing: { other: {} } },
    { model: 'x', pricing: { customPricing: { x: { promptCostPerMillionTokens: 1 } } } },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: {
            promptCostPerMillionTokens: 1,
            completionCostPerMillionTokens: 2,
            longContext: { promptCostPerMillionTokens: 2, completionCostPerMillionTokens: 4 },
          },
        },
      },
    },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: {
            promptCostPerMillionTokens: 1,
            completionCostPerMillionTokens: 2,
            longContext: {
              inputTokensAbove: 200_000,
              promptCostPerMillionTokens: 2,
              completionCostPerMillionTokens: 4,
              surcharge: 1,
            },
          },
        },
      },
    },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: { promptCostPerMillionTokens: Number.NaN, completionCostPerMillionTokens: 1 },
        },
      },
    },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: { promptCostPerMillionTokens: -1, completionCostPerMillionTokens: 1 },
        },
      },
    },
  ])('refuses what the decoder and the write must not carry: %j', (value) => {
    expect(isGoalAttemptCostEstimation(value)).toBe(false);
  });
});

describe('isGoalAttemptCostEstimation absence', () => {
  it('is not a selection: an attempt with nothing persisted is not the same as one persisted as none', () => {
    expect(isGoalAttemptCostEstimation(undefined)).toBe(false);
  });
});

describe('the estimator a budgeted file agent is built with (COR-1914)', () => {
  it('is persistable for every model the catalog prices, long-prompt tiers included', () => {
    const rows = createModelCatalog().descriptors.filter((row) => row.pricing !== undefined);
    expect(rows.length).toBeGreaterThan(0);
    // Prices a long-prompt tier too, so the case the shipped rows may not have is still covered.
    const withLongContext = {
      ...rows[0]!,
      pricing: {
        ...rows[0]!.pricing!,
        longContext: {
          inputTokensAbove: 200_000,
          inputPerMillionTokens: 8,
          outputPerMillionTokens: 30,
        },
      },
    };
    for (const row of [...rows, withLongContext]) {
      const { costEstimation } = costBudgetOptions({ perRunUsd: 1 }, row, []);
      expect(isGoalAttemptCostEstimation(JSON.parse(JSON.stringify(costEstimation)))).toBe(true);
    }
  });
});
