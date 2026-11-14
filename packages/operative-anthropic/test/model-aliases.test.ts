import { describe, expect, it } from 'bun:test';

import { ANTHROPIC_MODEL_ALIASES, resolveAnthropicModel } from '../src/anthropic-catalog.ts';

describe('model alias registry — Anthropic', () => {
  it.each(Object.entries(ANTHROPIC_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveAnthropicModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveAnthropicModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModel('claude-sonnet-4-6-20251114')).toBe('claude-sonnet-4-6-20251114');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveAnthropicModel('inherit')).toBe('inherit');
  });
});

describe('resolveAnthropicModel', () => {
  it('resolves every documented alias', () => {
    for (const [alias, expected] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
      expect(resolveAnthropicModel(alias)).toBe(expected);
    }
  });

  it('passes an unrecognized string through unchanged', () => {
    expect(resolveAnthropicModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModel('some-custom-fine-tune')).toBe('some-custom-fine-tune');
  });

  it('never resolves inherit', () => {
    expect(resolveAnthropicModel('inherit')).toBe('inherit');
  });
});
