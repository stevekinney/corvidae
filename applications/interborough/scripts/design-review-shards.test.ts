import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseArguments } from './design-review-capture.ts';
import {
  DEFAULT_WEIGHT,
  parseShard,
  planShards,
  SHARD_COUNT,
  weightOf,
} from './design-review-shards.ts';

const everySpecification = (): readonly string[] => {
  const options = parseArguments(['--out', '/tmp/shards']);
  if (typeof options === 'string') throw new Error(options);
  return options.specifications;
};

describe('planShards', () => {
  test('puts every specification in exactly one shard', () => {
    const specifications = everySpecification();
    const shards = planShards(specifications, SHARD_COUNT);
    expect(shards).toHaveLength(SHARD_COUNT);
    expect(shards.flatMap((shard) => shard.specifications).toSorted()).toEqual(
      [...specifications].toSorted(),
    );
  });

  test('keeps each shard within a third of the others, so no runner carries the sweep', () => {
    const shards = planShards(everySpecification(), SHARD_COUNT);
    const weights = shards.map((shard) => shard.weight);
    const heaviestFile = Math.max(...everySpecification().map((path) => weightOf(path)));
    // The heaviest shard is the heaviest file alone or close to the lightest shard's weight.
    expect(Math.max(...weights)).toBeLessThanOrEqual(Math.max(heaviestFile, Math.min(...weights) * 1.35));
    expect(Math.min(...weights)).toBeGreaterThan(0);
  });

  test('is the same plan every time, so each shard of each scheme agrees on it', () => {
    const specifications = everySpecification();
    expect(planShards(specifications, SHARD_COUNT)).toEqual(planShards(specifications, SHARD_COUNT));
  });

  test('weighs a specification the table does not list at the default', () => {
    expect(weightOf('tests/e2e/a-new-one.spec.ts')).toBe(DEFAULT_WEIGHT);
    expect(weightOf('tests/e2e/15-view-states.spec.ts')).toBeGreaterThan(DEFAULT_WEIGHT);
  });

  test('leaves a shard empty when there are fewer specifications than shards', () => {
    const shards = planShards(['tests/e2e/a.spec.ts', 'tests/e2e/b.spec.ts'], 3);
    expect(shards.map((shard) => shard.specifications.length).toSorted()).toEqual([0, 1, 1]);
  });
});

describe('parseShard', () => {
  test('reads index/count', () => {
    expect(parseShard('2/6')).toEqual({ index: 2, count: 6 });
  });

  test('refuses an index outside the count and anything that is not index/count', () => {
    for (const value of ['0/6', '7/6', '2', 'a/b', '2/0', '1/6/3']) {
      expect(typeof parseShard(value)).toBe('string');
    }
  });
});

describe('parseArguments --shard', () => {
  test('keeps the shard of the specifications the other flags chose', () => {
    const all = everySpecification();
    const first = parseArguments(['--out', '/tmp/shards', '--shard', '1/6']);
    if (typeof first === 'string') throw new Error(first);
    expect(first.shard).toEqual({ index: 1, count: 6 });
    expect(first.specifications.length).toBeLessThan(all.length);
    for (const specification of first.specifications) expect(all).toContain(specification);
  });

  test('refuses a bad shard', () => {
    expect(parseArguments(['--shard', '9/6'])).toContain('--shard must be');
  });
});

describe('the workflow', () => {
  const workflow = readFileSync(
    join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'design-review-capture.yml'),
    'utf8',
  );

  test('runs exactly the shards the plan makes, for each scheme, and merges them', () => {
    const listed = /shard:\s*\[([^\]]*)\]/.exec(workflow)?.[1]?.split(',').map((item) => Number(item.trim()));
    expect(listed).toEqual(Array.from({ length: SHARD_COUNT }, (_, position) => position + 1));
    expect(workflow).toContain(`--shards ${String(SHARD_COUNT)}`);
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('scripts/design-review-merge.ts');
  });
});
