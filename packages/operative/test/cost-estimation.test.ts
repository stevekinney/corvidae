import { describe, expect, it } from 'bun:test';
import { assertDefined } from './assert-defined';

import {
  type CostEstimate,
  defaultPricingTable,
  estimateCacheHitRate,
  estimateCost,
  getModelPricing,
  type ModelPricing,
} from '../src/cost-estimation.ts';
import { ANTHROPIC_LIMITS } from '../src/providers/model-catalog-data.ts';

describe('estimateCost', () => {
  it('computes correct cost for a known Anthropic model', () => {
    // claude-sonnet-4-20250514: prompt=$3/M, completion=$15/M
    const result: CostEstimate = estimateCost(
      { prompt: 1000, completion: 500, total: 1500 },
      'claude-sonnet-4-20250514',
    );

    expect(result.promptCost).toBe((1000 / 1_000_000) * 3);
    expect(result.completionCost).toBe((500 / 1_000_000) * 15);
    expect(result.totalCost).toBe(0.003 + 0.0075);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.usage).toEqual({ prompt: 1000, completion: 500, total: 1500 });
  });

  it('computes correct cost for a known OpenAI model', () => {
    // gpt-4o: prompt=$2.50/M, completion=$10/M
    const result: CostEstimate = estimateCost(
      { prompt: 2000, completion: 1000, total: 3000 },
      'gpt-4o',
    );

    expect(result.promptCost).toBe((2000 / 1_000_000) * 2.5);
    expect(result.completionCost).toBe((1000 / 1_000_000) * 10);
    expect(result.totalCost).toBe(0.005 + 0.01);
    expect(result.model).toBe('gpt-4o');
  });

  it('computes correct cost for a known Gemini model', () => {
    // gemini-2.5-pro: prompt=$1.25/M, completion=$10/M
    const result: CostEstimate = estimateCost(
      { prompt: 4000, completion: 2000, total: 6000 },
      'gemini-2.5-pro',
    );

    expect(result.promptCost).toBe((4000 / 1_000_000) * 1.25);
    expect(result.completionCost).toBe((2000 / 1_000_000) * 10);
    expect(result.totalCost).toBe(0.005 + 0.02);
    expect(result.model).toBe('gemini-2.5-pro');
  });

  it('throws for an unknown model', () => {
    expect(() =>
      estimateCost({ prompt: 100, completion: 50, total: 150 }, 'unknown-model'),
    ).toThrow('No pricing found for model: unknown-model');
  });

  it('uses custom pricing to override defaults for a known model', () => {
    const customPricing: Record<string, ModelPricing> = {
      'claude-sonnet-4-20250514': {
        promptCostPerMillionTokens: 5,
        completionCostPerMillionTokens: 20,
      },
    };

    const result = estimateCost(
      { prompt: 1000, completion: 500, total: 1500 },
      'claude-sonnet-4-20250514',
      { customPricing },
    );

    expect(result.promptCost).toBe((1000 / 1_000_000) * 5);
    expect(result.completionCost).toBe((500 / 1_000_000) * 20);
    expect(result.totalCost).toBe(0.005 + 0.01);
  });

  it('uses custom pricing for an entirely new model', () => {
    const customPricing: Record<string, ModelPricing> = {
      'my-custom-model': {
        promptCostPerMillionTokens: 1,
        completionCostPerMillionTokens: 2,
      },
    };

    const result = estimateCost(
      { prompt: 1_000_000, completion: 500_000, total: 1_500_000 },
      'my-custom-model',
      { customPricing },
    );

    expect(result.promptCost).toBe(1);
    expect(result.completionCost).toBe(1);
    expect(result.totalCost).toBe(2);
    expect(result.model).toBe('my-custom-model');
  });

  it('returns zero cost for zero usage', () => {
    const result = estimateCost({ prompt: 0, completion: 0, total: 0 }, 'claude-sonnet-4-20250514');

    expect(result.promptCost).toBe(0);
    expect(result.completionCost).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('prices Anthropic cache writes at 1.25x and cache reads at 0.1x the prompt rate', () => {
    // claude-sonnet-4-20250514: prompt=$3/M → write=$3.75/M, read=$0.30/M
    const result = estimateCost(
      {
        prompt: 1000,
        completion: 0,
        total: 1000,
        cacheCreationTokens: 2000,
        cacheReadTokens: 5000,
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.cacheWriteCost).toBeCloseTo((2000 / 1_000_000) * 3.75, 10);
    expect(result.cacheReadCost).toBeCloseTo((5000 / 1_000_000) * 0.3, 10);
    expect(result.totalCost).toBeCloseTo(
      result.promptCost + result.completionCost + result.cacheWriteCost + result.cacheReadCost,
      10,
    );
  });

  it('prices OpenAI cache reads at 0.5x the prompt rate with no cache-write charge', () => {
    // gpt-4o: prompt=$2.50/M → read=$1.25/M; no cache-write pricing defined.
    const result = estimateCost(
      { prompt: 1000, completion: 0, total: 1000, cacheReadTokens: 4000 },
      'gpt-4o',
    );

    expect(result.cacheReadCost).toBeCloseTo((4000 / 1_000_000) * 1.25, 10);
    expect(result.cacheWriteCost).toBe(0);
  });

  it('prices cache tokens at 0 when the usage reports them but the model has no cache pricing', () => {
    const result = estimateCost(
      { prompt: 1000, completion: 0, total: 1000, cacheCreationTokens: 500, cacheReadTokens: 500 },
      'my-unpriced-cache-model',
      {
        customPricing: {
          'my-unpriced-cache-model': {
            promptCostPerMillionTokens: 1,
            completionCostPerMillionTokens: 2,
          },
        },
      },
    );

    expect(result.cacheWriteCost).toBe(0);
    expect(result.cacheReadCost).toBe(0);
    expect(result.totalCost).toBe(result.promptCost + result.completionCost);
  });

  it('omits cache cost entirely (cost 0) when usage has no cache token fields', () => {
    const result = estimateCost({ prompt: 1000, completion: 500, total: 1500 }, 'gpt-4o');

    expect(result.cacheWriteCost).toBe(0);
    expect(result.cacheReadCost).toBe(0);
  });
});

describe('getModelPricing', () => {
  it('returns pricing for a known model', () => {
    const pricing = getModelPricing('gpt-4o');

    expect(pricing).toBeDefined();
    expect(pricing!.promptCostPerMillionTokens).toBe(2.5);
    expect(pricing!.completionCostPerMillionTokens).toBe(10);
  });

  it('returns undefined for an unknown model', () => {
    const pricing = getModelPricing('nonexistent-model');

    expect(pricing).toBeUndefined();
  });

  it('respects custom pricing over defaults', () => {
    const customPricing: Record<string, ModelPricing> = {
      'gpt-4o': {
        promptCostPerMillionTokens: 99,
        completionCostPerMillionTokens: 199,
      },
    };

    const pricing = getModelPricing('gpt-4o', { customPricing });

    expect(pricing).toBeDefined();
    expect(pricing!.promptCostPerMillionTokens).toBe(99);
    expect(pricing!.completionCostPerMillionTokens).toBe(199);
  });
});

describe('defaultPricingTable', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(defaultPricingTable)).toBe(true);
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
    for (const [model, pricing] of Object.entries(defaultPricingTable)) {
      if (!model.startsWith('claude-')) continue;
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
      expect({ model, priced: defaultPricingTable[model] !== undefined }).toEqual({
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
      const pricing = assertDefined(defaultPricingTable[model]);
      expect(pricing.promptCostPerMillionTokens).toBe(input);
      expect(pricing.completionCostPerMillionTokens).toBe(output);
      expect(pricing.cacheReadCostPerMillionTokens).toBeCloseTo(cacheRead, 10);
    }
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
      const pricing = defaultPricingTable[model];
      expect(pricing).toBeDefined();
      expect(assertDefined(pricing).cacheReadCostPerMillionTokens).toBe(
        assertDefined(pricing).promptCostPerMillionTokens * 0.5,
      );
      expect(assertDefined(pricing).cacheWriteCostPerMillionTokens).toBeUndefined();
    }
  });

  it('gives Gemini models no cache pricing', () => {
    for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']) {
      const pricing = defaultPricingTable[model];
      expect(pricing).toBeDefined();
      expect(assertDefined(pricing).cacheReadCostPerMillionTokens).toBeUndefined();
      expect(assertDefined(pricing).cacheWriteCostPerMillionTokens).toBeUndefined();
    }
  });
});

describe('estimateCacheHitRate', () => {
  it('returns undefined when the usage carries no cache signal at all', () => {
    expect(estimateCacheHitRate({ prompt: 100, completion: 20, total: 120 })).toBeUndefined();
  });

  it('returns 0 for a pure cache-write request (first turn, no reads yet)', () => {
    expect(
      estimateCacheHitRate({ prompt: 0, completion: 5, total: 5, cacheCreationTokens: 500 }),
    ).toBe(0);
  });

  it('returns 1 when the entire request was served from cache', () => {
    expect(estimateCacheHitRate({ prompt: 0, completion: 5, total: 5, cacheReadTokens: 500 })).toBe(
      1,
    );
  });

  it('computes the fraction served from cache when prompt, reads, and writes are mixed', () => {
    // 100 read + 50 write + 50 fresh prompt = 200 total input; 100/200 = 0.5.
    expect(
      estimateCacheHitRate({
        prompt: 50,
        completion: 10,
        total: 160,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
      }),
    ).toBe(0.5);
  });
});
