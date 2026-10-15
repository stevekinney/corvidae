import { describe, expect, test } from 'bun:test';

import { isMouseReport } from './mouse-report.ts';

describe('isMouseReport', () => {
  test.each([
    ['text', '\u001b[<0;12;4M'],
    ['text', '\u001b[<35;1;1m'],
    ['text', '\u001b[<65;300;200M'],
    ['text', '\u001b[32;12;4M'],
    ['text', '\u001b[M "$'],
    ['text', '\u001b[M \u0123\u0456'],
    ['binary', '\u001b[M \u0080\u00ff'],
  ] as const)('recognises a %s report %j', (kind, data) => {
    expect(isMouseReport({ kind, data })).toBe(true);
  });

  test.each([
    ['text', 'a'],
    ['text', '\u001b[A'],
    ['text', '\u001b[1;5M'],
    ['text', '\u001b[<0;1M'],
    ['text', '\u001b[<0;1;1MX'],
    ['text', 'x\u001b[<0;1;1M'],
    ['text', '\u001b[M  '],
    ['text', '\u001b[M    '],
    ['text', '\u001b[I'],
    ['binary', '\u0080\u00ff'],
    ['binary', '\u001b[M \u0080'],
    ['binary', '\u001b[M \u0080\u00ff\u00ff'],
  ] as const)('does not mistake a %s report %j for one', (kind, data) => {
    expect(isMouseReport({ kind, data })).toBe(false);
  });
});
