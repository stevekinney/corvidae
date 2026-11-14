import { describe, expect, it } from 'bun:test';

import { GEMINI_THINKING_MODELS, resolveGeminiEffort } from '../src/gemini-catalog.ts';

describe('resolveGeminiEffort', () => {
  it('maps every tier to a thinkingBudget on a thinking-capable model', () => {
    expect(resolveGeminiEffort('low', 'gemini-2.5-flash')).toEqual({
      effort: 'low',
      thinkingBudget: 1024,
    });
    expect(resolveGeminiEffort('max', 'gemini-2.5-pro')).toEqual({
      effort: 'max',
      thinkingBudget: -1,
    });
  });

  it('returns undefined (omit thinkingConfig) for a non-thinking model', () => {
    expect(resolveGeminiEffort('high', 'gemini-2.0-flash')).toBeUndefined();
  });

  it('agrees with the GEMINI_THINKING_MODELS set', () => {
    for (const model of GEMINI_THINKING_MODELS) {
      expect(resolveGeminiEffort('medium', model)).toBeDefined();
    }
    expect(resolveGeminiEffort('medium', 'gemini-2.0-flash')).toBeUndefined();
  });
});
