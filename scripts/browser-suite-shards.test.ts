import { describe, expect, test } from 'bun:test';

import { shardSuites } from './browser-suite-shards.ts';

describe('browser suite shards', () => {
  test('deal every suite once, heaviest first to the lightest shard', () => {
    const suites = [
      { name: 'a', weight: 100 },
      { name: 'b', weight: 60 },
      { name: 'c', weight: 50 },
      { name: 'd', weight: 10 },
      { name: 'e', weight: 1 },
    ];
    const shards = shardSuites(suites, 2);
    expect(shards).toEqual([
      ['a', 'd', 'e'],
      ['b', 'c'],
    ]);
    expect(shards.flat().toSorted()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('the same suites always deal the same way, whatever order they come in', () => {
    const suites = [
      { name: 'x', weight: 5 },
      { name: 'y', weight: 5 },
      { name: 'z', weight: 5 },
    ];
    expect(shardSuites(suites, 2)).toEqual(shardSuites(suites.toReversed(), 2));
  });
});
