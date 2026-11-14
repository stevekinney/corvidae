import { describe, expect, test } from 'bun:test';

import { exploreInterleavings, kindSequences } from './host-sessions-interleavings.ts';

describe('every interleaving', () => {
  test('of three dispatches of every kind holds exactly the admitted-or-running', () => {
    let prefixes = 0;
    const failures: string[] = [];
    for (const kinds of kindSequences(3)) {
      const result = exploreInterleavings(kinds, false);
      prefixes += result.prefixes;
      failures.push(...result.failures);
    }
    expect(failures).toEqual([]);
    // 64 triples of kinds, every prefix of every interleaving: seconds of work, so this lane.
    expect(prefixes).toBe(8_861_952);
  });
});
