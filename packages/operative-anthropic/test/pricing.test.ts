import { describe, expect, it } from 'bun:test';

import { getModelPricing } from '@lostgradient/operative';

import { ANTHROPIC_LIMITS, anthropicPricingTable } from '../src/anthropic-catalog.ts';

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

describe('anthropicPricingTable', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(anthropicPricingTable)).toBe(true);
  });

  it('gives every Claude model 5-minute cache writes at 1.25x and its published cache-read rate', () => {
    // Anthropic's pricing page: cache hits cost 0.025x input on Fable 5.1 / Mythos 5.1, 0.05x on
    // Opus 5.5 / Sonnet 5.5, and 0.1x on every other model.
    const readMultipliers: Record<string, number> = {
      'claude-fable-5-1': 0.025,
      'claude-mythos-5-1': 0.025,
      'claude-opus-5-5': 0.05,
      'claude-sonnet-5-5': 0.05,
    };
    for (const [model, pricing] of Object.entries(anthropicPricingTable)) {
      expect(pricing.cacheWriteCostPerMillionTokens).toBe(
        pricing.promptCostPerMillionTokens * 1.25,
      );
      expect(pricing.cacheReadCostPerMillionTokens).toBeCloseTo(
        pricing.promptCostPerMillionTokens * (readMultipliers[model] ?? 0.1),
        10,
      );
    }
  });

  it('prices every Claude model in the Anthropic model catalog', () => {
    // A model Operative can resolve but not price makes the cost budget monitor throw on the
    // first step and leaves every cost estimate empty.
    for (const model of Object.keys(ANTHROPIC_LIMITS)) {
      expect({ model, priced: anthropicPricingTable[model] !== undefined }).toEqual({
        model,
        priced: true,
      });
    }
  });

  it('prices the current Claude models at Anthropic list prices', () => {
    const listPrices: Record<string, [input: number, output: number, cacheRead: number]> = {
      'claude-fable-5-1': [10, 50, 0.25],
      'claude-mythos-5-1': [10, 50, 0.25],
      'claude-fable-5': [10, 50, 1],
      'claude-mythos-5': [10, 50, 1],
      'claude-opus-5-5': [4, 20, 0.2],
      'claude-opus-5': [5, 25, 0.5],
      'claude-opus-4-8': [5, 25, 0.5],
      'claude-opus-4-7': [5, 25, 0.5],
      'claude-opus-4-6': [5, 25, 0.5],
      'claude-opus-4-5': [5, 25, 0.5],
      'claude-sonnet-5-5': [2, 10, 0.1],
      'claude-sonnet-5': [2, 10, 0.2],
      'claude-sonnet-4-6': [3, 15, 0.3],
      'claude-haiku-5-5': [0.1, 0.5, 0.01],
      'claude-haiku-4-5': [1, 5, 0.1],
    };
    for (const [model, [input, output, cacheRead]] of Object.entries(listPrices)) {
      const pricing = assertDefined(anthropicPricingTable[model]);
      expect(pricing.promptCostPerMillionTokens).toBe(input);
      expect(pricing.completionCostPerMillionTokens).toBe(output);
      expect(pricing.cacheReadCostPerMillionTokens).toBeCloseTo(cacheRead, 10);
    }
  });

  it('is what a host passes as customPricing: Operative prices nothing it is not given', () => {
    expect(getModelPricing('claude-sonnet-4-6')).toBeUndefined();
    expect(getModelPricing('claude-sonnet-4-6', { customPricing: anthropicPricingTable })).toEqual(
      anthropicPricingTable['claude-sonnet-4-6'],
    );
  });
});
