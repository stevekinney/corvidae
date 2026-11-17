import { describe, expect, test } from 'bun:test';

import { fitMiddleHead, MIDDLE_ELLIPSIS } from './text-middle.ts';

/** Every character is ten pixels wide, the ellipsis included. */
const measure = (text: string): number => Array.from(text).length * 10;

describe('fitMiddleHead', () => {
  const head = Array.from('payments-worker-eu-west');

  test('returns nothing when the whole head fits', () => {
    expect(fitMiddleHead(head, head.length * 10, measure)).toBeUndefined();
    expect(fitMiddleHead(head, 1_000, measure)).toBeUndefined();
  });

  test('returns the width of the longest cut that still fits with its ellipsis', () => {
    // 95px holds nine characters; one of them is the ellipsis, so eight characters of head stay.
    expect(fitMiddleHead(head, 95, measure)).toBe(90);
    expect(fitMiddleHead(head, 90, measure)).toBe(90);
    expect(fitMiddleHead(head, 89, measure)).toBe(80);
  });

  test('a width is always the width of a real cut, never the slack the browser would leave', () => {
    for (let available = 10; available < head.length * 10; available += 3) {
      const width = fitMiddleHead(head, available, measure);
      expect(width).toBeDefined();
      expect(width! <= available).toBe(true);
      expect(available - width!).toBeLessThan(10);
    }
  });

  test('leaves only the ellipsis when no character fits beside it', () => {
    expect(fitMiddleHead(head, 12, measure)).toBe(measure(MIDDLE_ELLIPSIS));
  });

  test('never reports more room than there is', () => {
    expect(fitMiddleHead(head, 4, measure)).toBe(4);
  });

  test('counts a surrogate pair as one character', () => {
    const emoji = Array.from('\u{1F600}\u{1F600}\u{1F600}\u{1F600}');
    expect(fitMiddleHead(emoji, 25, measure)).toBe(20);
  });
});
