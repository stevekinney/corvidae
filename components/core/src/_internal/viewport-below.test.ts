import { describe, expect, test } from 'bun:test';

import {
  PHONE_VIEWPORT_BREAKPOINT,
  isSimpleCssLength,
  readViewportBreakpoint,
} from './viewport-below.svelte.ts';

describe('readViewportBreakpoint', () => {
  test('turns the phone form off for false', () => {
    expect(readViewportBreakpoint(false, 'Table', 'stackBelow')).toBeUndefined();
  });

  test('accepts and trims simple CSS lengths', () => {
    expect(readViewportBreakpoint(PHONE_VIEWPORT_BREAKPOINT, 'Table', 'stackBelow')).toBe('640px');
    expect(readViewportBreakpoint(' 40rem ', 'Popover', 'sheetBelow')).toBe('40rem');
  });

  test('rejects anything that is not a simple CSS length', () => {
    for (const value of ['640', 'calc(1px + 2px)', '640px) or (width > 0', '', 'wide']) {
      expect(() => readViewportBreakpoint(value, 'Popover', 'sheetBelow')).toThrow(
        'Popover sheetBelow must be a CSS length such as "640px", or false.',
      );
    }
  });
});

describe('isSimpleCssLength', () => {
  test('matches a unitless zero and positive lengths only', () => {
    expect(isSimpleCssLength('0')).toBe(true);
    expect(isSimpleCssLength('639.98px')).toBe(true);
    expect(isSimpleCssLength('.5rem')).toBe(true);
    expect(isSimpleCssLength('-1px')).toBe(false);
    expect(isSimpleCssLength('10%')).toBe(false);
  });
});
