import { describe, expect, it } from 'bun:test';

import { OPENAI_MODEL_ALIASES, resolveOpenAIModel } from '../src/openai-catalog.ts';

describe('model alias registry — OpenAI', () => {
  it.each(Object.entries(OPENAI_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveOpenAIModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveOpenAIModel('gpt-4o')).toBe('gpt-4o');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveOpenAIModel('inherit')).toBe('inherit');
  });
});

describe('resolveOpenAIModel', () => {
  it('resolves every documented alias', () => {
    for (const [alias, expected] of Object.entries(OPENAI_MODEL_ALIASES)) {
      expect(resolveOpenAIModel(alias)).toBe(expected);
    }
  });

  it('passes an unrecognized string through unchanged', () => {
    expect(resolveOpenAIModel('gpt-4o')).toBe('gpt-4o');
  });

  it('never resolves inherit', () => {
    expect(resolveOpenAIModel('inherit')).toBe('inherit');
  });
});
