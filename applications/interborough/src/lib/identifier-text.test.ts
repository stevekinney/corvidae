import { describe, expect, test } from 'bun:test';

import { segmentIdentifiers } from './identifier-text.ts';

describe('segmentIdentifiers', () => {
  test('marks the identifiers the caller names and leaves the prose alone', () => {
    expect(
      segmentIdentifiers('request-human-input asks: Refund order order-1001 for $42.00?', [
        'request-human-input',
      ]),
    ).toEqual([
      { text: 'request-human-input', identifier: true },
      { text: ' asks: Refund order order-1001 for $42.00?', identifier: false },
    ]);
  });

  test('an identifier with no hyphen is still an identifier when the caller names it', () => {
    expect(segmentIdentifiers('echo answered', ['echo'])).toEqual([
      { text: 'echo', identifier: true },
      { text: ' answered', identifier: false },
    ]);
    expect(segmentIdentifiers('Run assistant?', ['assistant'])).toEqual([
      { text: 'Run ', identifier: false },
      { text: 'assistant', identifier: true },
      { text: '?', identifier: false },
    ]);
  });

  test('a hyphenated word the caller did not name is prose', () => {
    expect(segmentIdentifiers('A well-known follow-up for order-1001', ['echo'])).toEqual([
      { text: 'A well-known follow-up for order-1001', identifier: false },
    ]);
  });

  test('a word that merely contains an identifier is prose', () => {
    expect(segmentIdentifiers('echoes of the echo-loud agent', ['echo'])).toEqual([
      { text: 'echoes of the echo-loud agent', identifier: false },
    ]);
  });

  test('a name that contains another is matched whole, and every occurrence is marked', () => {
    expect(
      segmentIdentifiers('echo-loud then echo, then echo-loud', ['echo', 'echo-loud']),
    ).toEqual([
      { text: 'echo-loud', identifier: true },
      { text: ' then ', identifier: false },
      { text: 'echo', identifier: true },
      { text: ', then ', identifier: false },
      { text: 'echo-loud', identifier: true },
    ]);
  });

  test('a name with characters a pattern would read is matched as written', () => {
    expect(segmentIdentifiers('Run a.b+c now', ['a.b+c'])).toEqual([
      { text: 'Run ', identifier: false },
      { text: 'a.b+c', identifier: true },
      { text: ' now', identifier: false },
    ]);
    expect(segmentIdentifiers('Run axb+c now', ['a.b+c'])).toEqual([
      { text: 'Run axb+c now', identifier: false },
    ]);
  });

  test('is one prose segment when nothing is named, and none for no text', () => {
    expect(segmentIdentifiers('Which environment?', [])).toEqual([
      { text: 'Which environment?', identifier: false },
    ]);
    expect(segmentIdentifiers('Which environment?', [''])).toEqual([
      { text: 'Which environment?', identifier: false },
    ]);
    expect(segmentIdentifiers('', [])).toEqual([]);
    expect(segmentIdentifiers('', ['echo'])).toEqual([]);
  });
});
