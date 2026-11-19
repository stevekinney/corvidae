import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  duplicatePaths,
  mergeShards,
  missingShards,
  schemeGaps,
  type MergedEntry,
} from './design-review-merge.ts';

const entry = (overrides: Partial<MergedEntry> = {}): MergedEntry => ({
  source: 'home.spec.ts',
  world: 'sample-world',
  route: '/',
  state: 'ready',
  width: 1280,
  colorScheme: 'light',
  viewport: 'screens/home--sample-world--root--ready--1280--light.png',
  ...overrides,
});

describe('duplicatePaths', () => {
  test('finds two captures that resolve to the same file, and nothing else', () => {
    expect(duplicatePaths([entry(), entry({ state: 'other', viewport: 'screens/other.png' })]).size).toBe(0);
    const found = duplicatePaths([entry(), entry()]);
    expect([...found]).toEqual([['screens/home--sample-world--root--ready--1280--light.png', 2]]);
  });

  test('counts a whole-page file as a path too', () => {
    expect(duplicatePaths([entry({ full: 'screens/a.full.png' }), entry({ viewport: 'screens/b.png', full: 'screens/a.full.png' })]).get('screens/a.full.png')).toBe(2);
  });
});

describe('schemeGaps', () => {
  test('names a screen one scheme has and the other lacks', () => {
    const gaps = schemeGaps([
      entry(),
      entry({ colorScheme: 'dark' }),
      entry({ state: 'only-light', viewport: 'screens/x.png' }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('only-light');
    expect(gaps[0]).toContain('no dark capture');
  });

  test('has no gap when a run captured one scheme only', () => {
    expect(schemeGaps([entry(), entry({ state: 'b', viewport: 'screens/b.png' })])).toEqual([]);
  });
});

describe('missingShards', () => {
  test('names each planned shard no directory is for', () => {
    expect(
      missingShards(['capture-1-light-1', 'capture-1-light-2', 'capture-1-dark-1'], ['light', 'dark'], 2),
    ).toEqual(['dark shard 2']);
  });

  test('does not take shard 1 for shard 11', () => {
    expect(missingShards(['capture-1-light-11'], ['light'], 1)).toEqual(['light shard 1']);
  });
});

describe('mergeShards', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'design-review-merge-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function shard(name: string, entries: MergedEntry[], clean = true): Promise<void> {
    const directory = join(root, 'shards', name);
    await mkdir(join(directory, 'screens'), { recursive: true });
    for (const item of entries) await writeFile(join(directory, item.viewport), 'png');
    await writeFile(join(directory, 'manifest.jsonl'), entries.map((item) => `${JSON.stringify(item)}\n`).join(''));
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ clean, captures: entries.length }));
  }

  const dark = (): MergedEntry =>
    entry({ colorScheme: 'dark', viewport: 'screens/home--sample-world--root--ready--1280--dark.png' });
  const merge = () =>
    mergeShards({ shardsDirectory: join(root, 'shards'), out: join(root, 'merged'), schemes: ['light', 'dark'], shardCount: 1 });

  test('writes one manifest from every shard and finds nothing wrong with a whole run', async () => {
    await shard('c-light-1', [entry()]);
    await shard('c-dark-1', [dark()]);
    const result = await merge();
    expect(result.problems).toEqual([]);
    expect(result.captures).toBe(2);
    const lines = (await readFile(join(root, 'merged', 'manifest.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(await readFile(join(root, 'merged', 'screens', dark().viewport.slice('screens/'.length)), 'utf8')).toBe('png');
  });

  test('fails when a planned shard never uploaded, which is how a cut-short dark half hid', async () => {
    await shard('c-light-1', [entry()]);
    const result = await merge();
    expect(result.problems.join('\n')).toContain('dark shard 1 is missing');
  });

  test('fails when two shards wrote one file', async () => {
    await shard('c-light-1', [entry()]);
    await shard('c-dark-1', [dark(), entry()]);
    const result = await merge();
    expect(result.problems.join('\n')).toContain('claimed by 2 captures');
  });

  test('records a specification that failed as not clean without failing the merge', async () => {
    await shard('c-light-1', [entry()], false);
    await shard('c-dark-1', [dark()]);
    const result = await merge();
    expect(result.problems).toEqual([]);
    expect(result.clean).toBe(false);
  });

  test('fails when nothing was captured', async () => {
    await shard('c-light-1', []);
    await shard('c-dark-1', []);
    const result = await merge();
    expect(result.problems).toContain('no capture was written by any shard');
  });
});
