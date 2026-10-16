import { describe, expect, test } from 'bun:test';

import { lexicalVector } from './embedder';
import {
  computeEnvelopeSchema,
  costOf,
  envelopeDigest,
  estimateTokens,
  memoryLifecycleEnvelope,
  SCENARIO_TOOLS,
} from './envelope';
import { MEMORY_LIFECYCLE_PROMPT_REVISION } from './prompt';

describe('memoryLifecycleEnvelope', () => {
  test('fixes one budget per lane that differs only in the model', () => {
    const deterministic = memoryLifecycleEnvelope('deterministic');
    const stochastic = memoryLifecycleEnvelope('stochastic');
    expect(deterministic.model).toEqual({
      provider: 'fixture',
      name: 'reference-policy',
      revision: '1',
      noise: 0,
    });
    expect(stochastic.model.noise).toBeGreaterThan(0);
    const { lane: _lane, model: _model, ...shared } = deterministic;
    expect(stochastic).toMatchObject(shared);
    expect(deterministic.tools).toEqual([...SCENARIO_TOOLS]);
    expect(deterministic.promptRevision).toBe(MEMORY_LIFECYCLE_PROMPT_REVISION);
  });

  test('digests each envelope, so a comparison that mixed envelopes is detectable', async () => {
    const digest = await envelopeDigest(memoryLifecycleEnvelope('deterministic'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await envelopeDigest(memoryLifecycleEnvelope('deterministic'))).toBe(digest);
    expect(await envelopeDigest(memoryLifecycleEnvelope('stochastic'))).not.toBe(digest);
  });

  test('rejects an envelope without a budget', () => {
    const { maximumSteps: _steps, ...partial } = memoryLifecycleEnvelope('deterministic');
    expect(computeEnvelopeSchema.safeParse(partial).success).toBe(false);
  });
});

describe('counting', () => {
  test('counts a token per four characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test("prices usage at the envelope's rates", () => {
    const envelope = memoryLifecycleEnvelope('deterministic');
    expect(costOf({ prompt: 1_000_000, completion: 0, total: 1_000_000 }, envelope)).toBe(3);
    expect(costOf({ prompt: 0, completion: 1_000_000, total: 1_000_000 }, envelope)).toBe(15);
  });
});

describe('lexicalVector', () => {
  const cosine = (left: number[], right: number[]) =>
    left.reduce((total, value, index) => total + value * right[index]!, 0);

  test('makes texts that share content words similar, and stop words irrelevant', () => {
    const address = lexicalVector('Shipping address: 17 Cedar Lane', 64);
    const query = lexicalVector('the shipping address', 64);
    const unrelated = lexicalVector('Favorite bookstore downtown', 64);
    expect(Math.hypot(...address)).toBeCloseTo(1);
    expect(cosine(address, query)).toBeGreaterThan(cosine(address, unrelated));
    expect(lexicalVector('shipping address', 64)).toEqual(query);
  });

  test('gives a text with no content words the first basis vector', () => {
    const vector = lexicalVector('the of and', 8);
    expect(vector).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});
