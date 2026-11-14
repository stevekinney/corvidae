import { describe, expect, it } from 'bun:test';

import { OPENAI_REASONING_MODELS, resolveOpenAIEffort } from '../src/openai-catalog.ts';

describe('resolveOpenAIEffort', () => {
  it('passes low and medium through unchanged on a reasoning model', () => {
    expect(resolveOpenAIEffort('low', 'o3')).toBe('low');
    expect(resolveOpenAIEffort('medium', 'o3-mini')).toBe('medium');
  });

  it('clamps high, xhigh, and max down to high', () => {
    expect(resolveOpenAIEffort('high', 'o3')).toBe('high');
    expect(resolveOpenAIEffort('xhigh', 'o3')).toBe('high');
    expect(resolveOpenAIEffort('max', 'o4-mini')).toBe('high');
  });

  it('returns undefined (omit the parameter) for a non-reasoning model', () => {
    expect(resolveOpenAIEffort('low', 'gpt-4o')).toBeUndefined();
    expect(resolveOpenAIEffort('max', 'gpt-4.1-mini')).toBeUndefined();
  });

  it('agrees with the OPENAI_REASONING_MODELS set', () => {
    for (const model of OPENAI_REASONING_MODELS) {
      expect(resolveOpenAIEffort('low', model)).toBe('low');
    }
    expect(resolveOpenAIEffort('low', 'gpt-4o')).toBeUndefined();
  });
});
