import { describe, expect, it } from 'bun:test';

import {
  type CostEstimate,
  type CostEstimationOptions,
  estimateCacheHitRate,
  estimateCost as estimateCostWith,
  getModelPricing as getModelPricingWith,
  type ModelPricing,
} from '../src/cost-estimation.ts';
import { fixturePricing } from '../src/testing/model-catalog.test-support.ts';

// Operative holds no price of its own, so these tests price from the neutral fixture's prices,
// passed the way a host passes its own. A price a test gives wins over the fixture's.
function withFixturePricing(options?: CostEstimationOptions): CostEstimationOptions {
  return { customPricing: { ...fixturePricing, ...options?.customPricing } };
}
const estimateCost = (
  usage: Parameters<typeof estimateCostWith>[0],
  model: string,
  options?: CostEstimationOptions,
  scope?: Parameters<typeof estimateCostWith>[3],
): CostEstimate => estimateCostWith(usage, model, withFixturePricing(options), scope);
const getModelPricing = (model: string, options?: CostEstimationOptions) =>
  getModelPricingWith(model, withFixturePricing(options));

describe('estimateCost', () => {
  it('computes correct cost for a known Anthropic model', () => {
    // alpha-medium: prompt=$3/M, completion=$15/M
    const result: CostEstimate = estimateCost(
      { prompt: 1000, completion: 500, total: 1500 },
      'alpha-medium',
    );

    expect(result.promptCost).toBe((1000 / 1_000_000) * 3);
    expect(result.completionCost).toBe((500 / 1_000_000) * 15);
    expect(result.totalCost).toBe(0.003 + 0.0075);
    expect(result.model).toBe('alpha-medium');
    expect(result.usage).toEqual({ prompt: 1000, completion: 500, total: 1500 });
  });

  it('computes correct cost for a known OpenAI model', () => {
    // beta-standard: prompt=$2.50/M, completion=$10/M
    const result: CostEstimate = estimateCost(
      { prompt: 2000, completion: 1000, total: 3000 },
      'beta-standard',
    );

    expect(result.promptCost).toBe((2000 / 1_000_000) * 2.5);
    expect(result.completionCost).toBe((1000 / 1_000_000) * 10);
    expect(result.totalCost).toBe(0.005 + 0.01);
    expect(result.model).toBe('beta-standard');
  });

  it('computes correct cost for a known Gemini model', () => {
    // gamma-pro: prompt=$1.25/M, completion=$10/M
    const result: CostEstimate = estimateCost(
      { prompt: 4000, completion: 2000, total: 6000 },
      'gamma-pro',
    );

    expect(result.promptCost).toBe((4000 / 1_000_000) * 1.25);
    expect(result.completionCost).toBe((2000 / 1_000_000) * 10);
    expect(result.totalCost).toBe(0.005 + 0.02);
    expect(result.model).toBe('gamma-pro');
  });

  it('throws for an unknown model', () => {
    expect(() =>
      estimateCost({ prompt: 100, completion: 50, total: 150 }, 'unknown-model'),
    ).toThrow('No pricing found for model: unknown-model');
  });

  it('uses custom pricing to override defaults for a known model', () => {
    const customPricing: Record<string, ModelPricing> = {
      'alpha-medium': {
        promptCostPerMillionTokens: 5,
        completionCostPerMillionTokens: 20,
      },
    };

    const result = estimateCost({ prompt: 1000, completion: 500, total: 1500 }, 'alpha-medium', {
      customPricing,
    });

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
    const result = estimateCost({ prompt: 0, completion: 0, total: 0 }, 'alpha-medium');

    expect(result.promptCost).toBe(0);
    expect(result.completionCost).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('prices Anthropic cache writes at 1.25x and cache reads at 0.1x the prompt rate', () => {
    // alpha-medium: prompt=$3/M → write=$3.75/M, read=$0.30/M
    const result = estimateCost(
      {
        prompt: 1000,
        completion: 0,
        total: 1000,
        cacheCreationTokens: 2000,
        cacheReadTokens: 5000,
      },
      'alpha-medium',
    );

    expect(result.cacheWriteCost).toBeCloseTo((2000 / 1_000_000) * 3.75, 10);
    expect(result.cacheReadCost).toBeCloseTo((5000 / 1_000_000) * 0.3, 10);
    expect(result.totalCost).toBeCloseTo(
      result.promptCost + result.completionCost + result.cacheWriteCost + result.cacheReadCost,
      10,
    );
  });

  it('prices OpenAI cache reads at 0.5x the prompt rate with no cache-write charge', () => {
    // beta-standard: prompt=$2.50/M → read=$1.25/M; no cache-write pricing defined.
    const result = estimateCost(
      { prompt: 1000, completion: 0, total: 1000, cacheReadTokens: 4000 },
      'beta-standard',
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
    const result = estimateCost({ prompt: 1000, completion: 500, total: 1500 }, 'beta-standard');

    expect(result.cacheWriteCost).toBe(0);
    expect(result.cacheReadCost).toBe(0);
  });
});

describe('estimateCost: Claude Haiku 5.5 long-prompt tier', () => {
  // Anthropic's pricing page: $0.10 / $0.50 per MTok up to 100,000 prompt tokens, and
  // $0.50 / $2.50 (cache writes $0.625, cache reads $0.05) beyond.
  it('prices a request at or below 100,000 input tokens at the base tier', () => {
    const estimate = estimateCost(
      { prompt: 100_000, completion: 1_000_000, total: 1_100_000 },
      'alpha-small',
    );
    expect(estimate.promptCost).toBeCloseTo(0.01, 10);
    expect(estimate.completionCost).toBeCloseTo(0.5, 10);
  });

  it('prices every category at the long-prompt tier once input exceeds 100,000 tokens', () => {
    const estimate = estimateCost(
      {
        prompt: 1,
        completion: 1_000_000,
        total: 1_100_001,
        cacheReadTokens: 50_000,
        cacheCreationTokens: 50_000,
      },
      'alpha-small',
    );
    expect(estimate.promptCost).toBeCloseTo(0.5 / 1_000_000, 12);
    expect(estimate.completionCost).toBeCloseTo(2.5, 10);
    expect(estimate.cacheReadCost).toBeCloseTo(0.05 * 0.05, 10);
    expect(estimate.cacheWriteCost).toBeCloseTo(0.05 * 0.625, 10);
  });

  it('keeps the base tier for an aggregate estimate, where input totals are not request sizes', () => {
    const estimate = estimateCost(
      { prompt: 500_000, completion: 0, total: 500_000 },
      'alpha-small',
      undefined,
      'aggregate',
    );
    expect(estimate.promptCost).toBeCloseTo(0.05, 10);
  });
});

describe('getModelPricing', () => {
  it('returns pricing for a known model', () => {
    const pricing = getModelPricing('beta-standard');

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
      'beta-standard': {
        promptCostPerMillionTokens: 99,
        completionCostPerMillionTokens: 199,
      },
    };

    const pricing = getModelPricing('beta-standard', { customPricing });

    expect(pricing).toBeDefined();
    expect(pricing!.promptCostPerMillionTokens).toBe(99);
    expect(pricing!.completionCostPerMillionTokens).toBe(199);
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
