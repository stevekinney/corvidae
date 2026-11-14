import { describe, expect, it } from 'bun:test';

import { GEMINI_MODEL_ALIASES, resolveGeminiModel } from '../src/gemini-catalog.ts';

describe('model alias registry — Gemini', () => {
  it.each(Object.entries(GEMINI_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveGeminiModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveGeminiModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveGeminiModel('inherit')).toBe('inherit');
  });
});

describe('resolveGeminiModel', () => {
  it('resolves every documented alias', () => {
    for (const [alias, expected] of Object.entries(GEMINI_MODEL_ALIASES)) {
      expect(resolveGeminiModel(alias)).toBe(expected);
    }
  });

  it('passes an unrecognized string through unchanged', () => {
    expect(resolveGeminiModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('never resolves inherit', () => {
    expect(resolveGeminiModel('inherit')).toBe('inherit');
  });
});
