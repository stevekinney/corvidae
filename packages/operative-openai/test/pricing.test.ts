import { describe, expect, it } from 'bun:test';

import { OPENAI_LIMITS, openAIPricingTable } from '../src/openai-catalog.ts';

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

describe('openAIPricingTable', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(openAIPricingTable)).toBe(true);
  });

  it('gives every OpenAI GPT/o-series model cache-read pricing but no cache-write pricing', () => {
    const openAIModels = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o3',
      'o3-mini',
      'o4-mini',
    ];
    for (const model of openAIModels) {
      const pricing = assertDefined(openAIPricingTable[model]);
      expect(pricing.cacheReadCostPerMillionTokens).toBe(pricing.promptCostPerMillionTokens * 0.5);
      expect(pricing.cacheWriteCostPerMillionTokens).toBeUndefined();
    }
  });

  it('prices every model in the OpenAI model catalog', () => {
    for (const model of Object.keys(OPENAI_LIMITS)) {
      expect({ model, priced: openAIPricingTable[model] !== undefined }).toEqual({
        model,
        priced: true,
      });
    }
  });

  it('prices gpt-4o at the published list price', () => {
    const pricing = assertDefined(openAIPricingTable['gpt-4o']);
    expect(pricing.promptCostPerMillionTokens).toBe(2.5);
    expect(pricing.completionCostPerMillionTokens).toBe(10);
  });
});
