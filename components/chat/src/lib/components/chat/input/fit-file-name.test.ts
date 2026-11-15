import { describe, expect, test } from 'bun:test';

import { fitStem, graphemes } from './fit-file-name.ts';

/** Every character is 10 wide, the ellipsis included, so widths are easy to read. */
const measure = (text: string): number => graphemes(text).length * 10;

describe('fitStem', () => {
  test('keeps a stem that fits', () => {
    expect(fitStem('ledger', measure, 60)).toBe('ledger');
    expect(fitStem('ledger', measure, 200)).toBe('ledger');
  });

  test('shortens to the longest start that fits with its ellipsis', () => {
    // 80 wide holds seven characters and the ellipsis.
    expect(fitStem('quarterly-reconciliation', measure, 80)).toBe('quarter…');
    expect(measure(fitStem('quarterly-reconciliation', measure, 80))).toBeLessThanOrEqual(80);
  });

  test('never leaves a space or nothing before the ellipsis', () => {
    expect(fitStem('year end report', measure, 50)).toBe('year…');
    expect(fitStem('quarterly', measure, 5)).toBe('q…');
  });

  test('never cuts inside a combined character', () => {
    // A family emoji is several code points joined; it is kept whole or left out.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(fitStem(`${family}${family}${family}`, measure, 20)).toBe(`${family}…`);
  });

  test('counts a character outside the basic plane as one', () => {
    expect(fitStem('\u{1F4C4}\u{1F4C4}\u{1F4C4}\u{1F4C4}', measure, 30)).toBe(
      '\u{1F4C4}\u{1F4C4}…',
    );
  });
});
