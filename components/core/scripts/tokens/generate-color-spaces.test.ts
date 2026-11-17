import { describe, expect, test } from 'bun:test';

import { serializeEntryValue } from '../../src/tokens/runtime/value-entry.ts';
import { colorEntry } from './generator-test-support.ts';

const css = (value: unknown) => serializeEntryValue(colorEntry({ value }), new Map());

describe('colors authored outside oklch and srgb keep their space in CSS', () => {
  test('Display P3 is written as color(display-p3 …), never converted', () => {
    expect(css({ colorSpace: 'display-p3', components: [1, 0, 0] })).toBe(
      'color(display-p3 1 0 0)',
    );
    expect(css({ colorSpace: 'display-p3', components: [0.2, 0.3, 0.9], alpha: 0.5 })).toBe(
      'color(display-p3 0.2 0.3 0.9 / 0.5)',
    );
  });

  test('the other predefined spaces use color()', () => {
    for (const space of [
      'srgb-linear',
      'a98-rgb',
      'prophoto-rgb',
      'rec2020',
      'xyz-d50',
      'xyz-d65',
    ]) {
      expect(css({ colorSpace: space, components: [0.1, 0.2, 0.3] })).toBe(
        `color(${space} 0.1 0.2 0.3)`,
      );
    }
  });

  test('the functional spaces use their own CSS function with the DTCG ranges', () => {
    expect(css({ colorSpace: 'lab', components: [50, 40, 59.5] })).toBe('lab(50% 40 59.5)');
    expect(css({ colorSpace: 'lch', components: [50, 40, 130] })).toBe('lch(50% 40 130)');
    expect(css({ colorSpace: 'oklab', components: [0.5, 0.1, 0.1] })).toBe('oklab(50% 0.1 0.1)');
    expect(css({ colorSpace: 'hsl', components: [120, 100, 50] })).toBe('hsl(120 100% 50%)');
    expect(css({ colorSpace: 'hwb', components: [120, 50, 50], alpha: 0.4 })).toBe(
      'hwb(120 50% 50% / 0.4)',
    );
    expect(css({ colorSpace: 'display-p3', components: ['none', 0, 1] })).toBe(
      'color(display-p3 none 0 1)',
    );
  });

  test('a fully transparent color is still the transparent keyword, and oklch is unchanged', () => {
    expect(css({ colorSpace: 'display-p3', components: [1, 0, 0], alpha: 0 })).toBe('transparent');
    expect(css({ colorSpace: 'oklch', components: [0.5, 0.1, 250] })).toBe('oklch(50% 0.1 250)');
  });
});
