import { describe, expect, test } from 'bun:test';

import { segmentIdentifiers } from './identifier-text.ts';

describe('segmentIdentifiers', () => {
  test('marks kebab-case names and ids, and leaves prose alone', () => {
    expect(
      segmentIdentifiers('request-human-input asks: Refund order order-1001 for $42.00?'),
    ).toEqual([
      { text: 'request-human-input', identifier: true },
      { text: ' asks: Refund order ', identifier: false },
      { text: 'order-1001', identifier: true },
      { text: ' for $42.00?', identifier: false },
    ]);
  });

  test('is one prose segment when nothing is hyphenated, and none for no text', () => {
    expect(segmentIdentifiers('Which environment?')).toEqual([
      { text: 'Which environment?', identifier: false },
    ]);
    expect(segmentIdentifiers('')).toEqual([]);
  });
});
