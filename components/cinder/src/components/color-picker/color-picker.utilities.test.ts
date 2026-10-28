import { describe, expect, test } from 'bun:test';

import {
  alphaFromKeyboard,
  formatHex,
  gradientFromKeyboard,
  hueFromKeyboard,
} from './color-picker.utilities.ts';

describe('formatHex', () => {
  test('formats an opaque color as a 6-digit hex string', () => {
    expect(formatHex(0, 100, 50, 1, false)).toBe('#ff0000');
  });

  test('appends a quantized alpha byte when withAlpha is true', () => {
    expect(formatHex(0, 100, 50, 0.5, true)).toBe('#ff000080');
  });
});

describe('gradientFromKeyboard', () => {
  const current = { h: 0, s: 50, l: 50, a: 1 };

  test('returns null for a key that does not move saturation or lightness', () => {
    expect(gradientFromKeyboard(current, 'Enter', false)).toBeNull();
  });
});

describe('hueFromKeyboard', () => {
  const current = { h: 100, s: 50, l: 50, a: 1 };

  test('moves the hue by a fixed 36 degrees on PageUp and PageDown, wrapping around the wheel', () => {
    expect(hueFromKeyboard(current, 'PageUp', false)?.h).toBe(136);
    expect(hueFromKeyboard(current, 'PageDown', false)?.h).toBe(64);
    expect(hueFromKeyboard({ ...current, h: 10 }, 'PageDown', false)?.h).toBe(334);
  });

  test('returns null for a key that does not move the hue', () => {
    expect(hueFromKeyboard(current, 'Enter', false)).toBeNull();
  });
});

describe('alphaFromKeyboard', () => {
  const current = { h: 0, s: 50, l: 50, a: 0.5 };

  test('moves the alpha by a tenth on PageUp and PageDown, staying between 0 and 1', () => {
    expect(alphaFromKeyboard(current, 'PageUp', false)?.a).toBeCloseTo(0.6, 6);
    expect(alphaFromKeyboard(current, 'PageDown', false)?.a).toBeCloseTo(0.4, 6);
    expect(alphaFromKeyboard({ ...current, a: 0.95 }, 'PageUp', false)?.a).toBe(1);
    expect(alphaFromKeyboard({ ...current, a: 0.05 }, 'PageDown', false)?.a).toBe(0);
  });

  test('returns null for a key that does not move the alpha', () => {
    expect(alphaFromKeyboard(current, 'Enter', false)).toBeNull();
  });
});
