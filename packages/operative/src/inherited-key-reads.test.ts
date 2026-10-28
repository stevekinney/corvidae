/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. Model names, scratchpad keys, command ids and field paths are all free-form strings,
 * so each case uses `constructor` and expects the lookup to find nothing.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { getModelPricing } from './cost-estimation';
import { createScratchpad } from './create-scratchpad';
import { planSessionInputPromotion } from './durable/session-input-delivery-store';
import { valueAtFieldPath } from './fresh-attempt/field-path';
import { requireLimits } from './providers/model-catalog-data';
import { resolveAnthropicEffort } from './providers/shared/effort';
import { resolveAnthropicModel } from './providers/shared/model-registry';
import { anthropicSamplingSupport } from './providers/shared/sampling';
import { anthropicDisabledThinkingRule } from './providers/shared/thinking';

describe('a model named after a name every object inherits', () => {
  test('has no pricing, effort support, alias, or sampling rule', () => {
    expect(getModelPricing('constructor')).toBeUndefined();
    expect(getModelPricing('constructor', { customPricing: {} })).toBeUndefined();
    expect(resolveAnthropicEffort('high', 'constructor')).toBeUndefined();
    expect(resolveAnthropicModel('constructor')).toBe('constructor');
    expect(anthropicSamplingSupport('constructor')).toBe('unsettled');
    expect(anthropicDisabledThinkingRule('constructor')).toBeUndefined();
  });

  test('has no catalog row, so the completeness check fails loudly', () => {
    expect(() => requireLimits('anthropic', 'constructor')).toThrow(/no MODEL_LIMITS entry/);
  });
});

describe('a scratchpad whose schema declares one key', () => {
  test('refuses the key constructor', () => {
    const scratchpad = createScratchpad({ schema: z.object({ plan: z.string() }) });
    scratchpad.set('plan', 'ship');
    expect(() => scratchpad.set('constructor', 'x')).toThrow(/not allowed by the schema/);
  });
});

describe('a command id named after a name every object inherits', () => {
  test('is not a recorded delivery, so it cannot be promoted', () => {
    const delivery = {
      id: 'input-1',
      commandId: 'constructor',
      deliveredAt: '2026-01-01T00:00:00.000Z',
      conversationMessageId: 'message-1',
      providerTurn: 1,
    } as unknown as Parameters<typeof planSessionInputPromotion>[2][number];
    expect(() => planSessionInputPromotion({}, 'run-1', [delivery])).toThrow(
      /no run is recorded as delivering it/,
    );
  });
});

describe('a field path through an object', () => {
  test('does not step into a name every object inherits', () => {
    expect(valueAtFieldPath({ a: 1 }, ['constructor'])).toBeUndefined();
    expect(valueAtFieldPath({ a: { b: 2 } }, ['a', 'b'])).toBe(2);
  });
});
