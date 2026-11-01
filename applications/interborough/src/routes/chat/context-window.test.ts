/**
 * What the context-window ring reads from a `bureau.contexts.window` report: the share the next
 * prompt fills, the tone that share earns, and what an unknown window leaves out.
 */
import { describe, expect, test } from 'bun:test';

import type { ContextWindow } from '../../lib/bureau-client.ts';
import { formatTokens, windowUse } from './context-window.ts';

function report(used: number, max: number | null): ContextWindow {
  return {
    maxTokens: max,
    usedEstimated: used,
    usedReported: null,
    categories: [{ name: 'messages', tokens: used }],
  };
}

describe('windowUse', () => {
  test('reads the share of the window the estimate fills, in whole percent', () => {
    expect(windowUse(report(42_000, 200_000))).toEqual({
      used: 42_000,
      max: 200_000,
      percent: 21,
      drawn: 0.21,
      tone: 'normal',
    });
  });

  test('warns from 70 percent and calls the window nearly full from 90', () => {
    expect(windowUse(report(69, 100)).tone).toBe('normal');
    expect(windowUse(report(70, 100)).tone).toBe('warning');
    expect(windowUse(report(89, 100)).tone).toBe('warning');
    expect(windowUse(report(90, 100)).tone).toBe('danger');
  });

  test('draws no more than a full ring for a prompt over the window, and still says the real share', () => {
    const use = windowUse(report(150, 100));
    expect(use.percent).toBe(150);
    expect(use.drawn).toBe(1);
    expect(use.tone).toBe('danger');
  });

  test('has no share and an unknown tone when the model’s window is not known, or is empty', () => {
    for (const max of [null, 0]) {
      expect(windowUse(report(1_200, max))).toEqual({
        used: 1_200,
        max: null,
        percent: null,
        drawn: 0,
        tone: 'unknown',
      });
    }
  });
});

describe('formatTokens', () => {
  test('separates thousands', () => {
    expect(formatTokens(1_234_567)).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
  });
});
