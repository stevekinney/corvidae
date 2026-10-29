/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. Model names, scratchpad keys, command ids and field paths are all free-form strings,
 * so each case uses `constructor` and expects the lookup to find nothing.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';

import { getModelPricing } from '@lostgradient/operative';
import {
  anthropicSamplingSupport,
  resolveAnthropicEffort,
  resolveAnthropicModel,
} from '@lostgradient/operative/provider-kit';
import { anthropicDisabledThinkingRule } from '../src/anthropic-thinking';

describe('a model named after a name every object inherits', () => {
  test('has no pricing, effort support, alias, or sampling rule', () => {
    expect(getModelPricing('constructor')).toBeUndefined();
    expect(getModelPricing('constructor', { customPricing: {} })).toBeUndefined();
    expect(resolveAnthropicEffort('high', 'constructor')).toBeUndefined();
    expect(resolveAnthropicModel('constructor')).toBe('constructor');
    expect(anthropicSamplingSupport('constructor')).toBe('unsettled');
    expect(anthropicDisabledThinkingRule('constructor')).toBeUndefined();
  });
});
