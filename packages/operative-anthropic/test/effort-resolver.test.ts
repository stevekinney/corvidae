import { describe, expect, it } from 'bun:test';

import { ANTHROPIC_EFFORT_SUPPORT, resolveAnthropicEffort } from '../src/anthropic-catalog.ts';

describe('resolveAnthropicEffort', () => {
  it('returns the requested tier unchanged when the model supports it', () => {
    expect(resolveAnthropicEffort('xhigh', 'claude-opus-4-8')).toBe('xhigh');
    expect(resolveAnthropicEffort('max', 'claude-sonnet-5')).toBe('max');
  });

  it('degrades xhigh to high on a model without xhigh support', () => {
    const supportedEfforts = ANTHROPIC_EFFORT_SUPPORT['claude-opus-4-6'];
    expect(supportedEfforts).toBeDefined();
    if (!supportedEfforts) throw new Error('Expected the Opus 4.6 capability fixture');
    const originalSupportedEfforts = [...supportedEfforts];

    expect(resolveAnthropicEffort('xhigh', 'claude-opus-4-6')).toBe('high');
    expect(resolveAnthropicEffort('xhigh', 'claude-sonnet-4-6')).toBe('high');
    expect(supportedEfforts).toEqual(originalSupportedEfforts);
  });

  it('exposes the documented capability table for a model without xhigh support', () => {
    expect(ANTHROPIC_EFFORT_SUPPORT['claude-opus-4-6']).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('gives every newly cataloged Claude model the full documented effort range', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]) {
      expect({ model, effort: resolveAnthropicEffort('xhigh', model) }).toEqual({
        model,
        effort: 'xhigh',
      });
      expect({ model, effort: resolveAnthropicEffort('max', model) }).toEqual({
        model,
        effort: 'max',
      });
    }
  });

  it('degrades Opus 4.5 above high, which it does not support', () => {
    expect(ANTHROPIC_EFFORT_SUPPORT['claude-opus-4-5']).toEqual(['low', 'medium', 'high']);
    expect(resolveAnthropicEffort('max', 'claude-opus-4-5')).toBe('high');
  });

  it('returns undefined (omit the parameter) for a model with no effort support', () => {
    expect(resolveAnthropicEffort('low', 'claude-haiku-4-5')).toBeUndefined();
    expect(resolveAnthropicEffort('max', 'claude-haiku-4-5')).toBeUndefined();
  });

  it('returns undefined for an unrecognized model — conservative default', () => {
    expect(resolveAnthropicEffort('medium', 'claude-some-future-model')).toBeUndefined();
  });
});
