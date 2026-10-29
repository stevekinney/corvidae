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
import {
  createSessionInputDeliveryStore,
  parseSessionInputDeliveries,
  planSessionInputPromotion,
} from './durable/session-input-delivery-store';
import { valueAtFieldPath } from './fresh-attempt/field-path';
import { anthropicDisabledThinkingRule } from './providers/anthropic-thinking';
import { requireLimits } from './providers/model-catalog-data';
import { mergeAssembledField } from './providers/openai-parts';
import { resolveAnthropicEffort } from './providers/shared/effort';
import { resolveAnthropicModel } from './providers/shared/model-registry';
import { anthropicSamplingSupport } from './providers/shared/sampling';

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

describe('a name of __proto__ chosen from outside', () => {
  test('is stored as an own field of a streamed message', () => {
    const assembled: Record<string, unknown> = {};
    mergeAssembledField(assembled, '__proto__', 'a');
    mergeAssembledField(assembled, '__proto__', 'b');
    mergeAssembledField(assembled, 'refusal', 'no');
    expect(Object.getPrototypeOf(assembled)).toBe(Object.prototype);
    expect(Object.keys(assembled)).toEqual(['__proto__', 'refusal']);
    expect(Object.getOwnPropertyDescriptor(assembled, '__proto__')?.value).toBe('ab');
  });

  test('is kept as a delivery record when a command claims it and when storage is read back', async () => {
    const data = new Map<string, string>();
    const kv = {
      get: async (key: string) => data.get(key) ?? null,
      conditionalBatch: async (
        expected: readonly { key: string; expectedValue: string | null }[],
        operations: readonly { type: string; key: string; value?: string }[],
      ) => {
        if (expected.some((entry) => (data.get(entry.key) ?? null) !== entry.expectedValue)) {
          return false;
        }
        for (const operation of operations) {
          if (operation.type === 'set') data.set(operation.key, operation.value ?? '');
        }
        return true;
      },
    } as unknown as Parameters<typeof createSessionInputDeliveryStore>[0];
    const store = createSessionInputDeliveryStore(kv, { retentionMs: 60_000, nowMs: () => 0 });

    const outcomes = await store.claim('session-1', 'run-1', ['__proto__'], async () => true);

    expect([...outcomes.values()]).toEqual(['claimed']);
    const stored = JSON.parse([...data.values()][0]!) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['__proto__']);
    const parsed = parseSessionInputDeliveries([...data.values()][0]!);
    expect(Object.keys(parsed)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});
