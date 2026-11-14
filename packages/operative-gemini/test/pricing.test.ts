import { describe, expect, it } from 'bun:test';

import { GEMINI_LIMITS, geminiPricingTable } from '../src/gemini-catalog.ts';

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

describe('geminiPricingTable', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(geminiPricingTable)).toBe(true);
  });

  it('gives Gemini models no cache pricing', () => {
    for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']) {
      const pricing = assertDefined(geminiPricingTable[model]);
      expect(pricing.cacheReadCostPerMillionTokens).toBeUndefined();
      expect(pricing.cacheWriteCostPerMillionTokens).toBeUndefined();
    }
  });

  it('prices every model in the Gemini model catalog', () => {
    for (const model of Object.keys(GEMINI_LIMITS)) {
      expect({ model, priced: geminiPricingTable[model] !== undefined }).toEqual({
        model,
        priced: true,
      });
    }
  });

  it('prices gemini-2.5-pro at the published list price', () => {
    const pricing = assertDefined(geminiPricingTable['gemini-2.5-pro']);
    expect(pricing.promptCostPerMillionTokens).toBe(1.25);
    expect(pricing.completionCostPerMillionTokens).toBe(10);
  });
});
