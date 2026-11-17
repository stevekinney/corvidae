import { describe, expect, test } from 'bun:test';

import { resolveVirtualItemHeight } from './fixed-virtual-window.ts';

describe('resolveVirtualItemHeight', () => {
  test('keeps a positive finite height', () => {
    expect(resolveVirtualItemHeight(24)).toBe(24);
  });

  test('uses the fallback for a height that cannot size a row', () => {
    for (const height of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveVirtualItemHeight(height)).toBe(1);
      expect(resolveVirtualItemHeight(height, 32)).toBe(32);
    }
  });
});
