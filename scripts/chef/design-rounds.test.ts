import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROUND_LIMIT, run } from './design-rounds.ts';

let sandbox: string;
let stateDirectory: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'design-rounds-'));
  stateDirectory = join(sandbox, 'state');
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A capture directory whose summary says whether its coverage was complete, or has none. */
function capture(
  name: string,
  coverage: { complete: boolean; missing?: unknown[] } | null,
): string {
  const directory = join(sandbox, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'summary.json'),
    JSON.stringify(coverage === null ? { captures: 3 } : { captures: 3, coverage }),
  );
  return directory;
}

const complete = { complete: true, missing: [] };

function dispatch(branch: string, directory: string) {
  return run([
    'dispatch',
    '--branch',
    branch,
    '--capture',
    directory,
    '--state-directory',
    stateDirectory,
  ]);
}

describe('design-rounds dispatch', () => {
  test('allows one full round and one narrow look, then returns NEEDS_JUDGMENT on the third dispatch', async () => {
    const first = await dispatch('chef/a', capture('one', complete));
    expect(first.code).toBe(0);
    expect(first.output).toContain('full round (round 1 of 2) counted');
    const second = await dispatch('chef/a', capture('two', complete));
    expect(second.code).toBe(0);
    expect(second.output).toContain('narrow look (round 2 of 2) counted');
    const third = await dispatch('chef/a', capture('three', complete));
    expect(third.code).toBe(1);
    expect(third.output).toContain('NEEDS_JUDGMENT');
    expect(ROUND_LIMIT).toBe(2);
  });

  test('counts per branch, so another branch still has its rounds', async () => {
    await dispatch('chef/a', capture('one', complete));
    await dispatch('chef/a', capture('two', complete));
    expect((await dispatch('chef/b', capture('three', complete))).code).toBe(0);
  });

  test('treats a repeated capture as the same round, not a new one', async () => {
    const directory = capture('one', complete);
    expect((await dispatch('chef/a', directory)).code).toBe(0);
    const again = await dispatch('chef/a', directory);
    expect(again.code).toBe(0);
    expect(again.output).toContain('already counted');
    expect((await dispatch('chef/a', capture('two', complete))).code).toBe(0);
    expect((await dispatch('chef/a', capture('three', complete))).code).toBe(1);
  });

  test('counts only a round whose capture manifest was complete: coverage before counting', async () => {
    const incomplete = capture('partial', { complete: false, missing: [{}, {}] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await dispatch('chef/a', incomplete);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain('not counted');
      expect(refused.output).toContain('missing 2 declared state(s)');
    }
    const unplanned = await dispatch('chef/a', capture('unplanned', null));
    expect(unplanned.code).toBe(1);
    expect(unplanned.output).toContain('captured without --expect');
    expect((await dispatch('chef/a', join(sandbox, 'absent'))).code).toBe(1);
    // None of the refusals spent a round: both rounds are still there.
    expect((await dispatch('chef/a', capture('one', complete))).code).toBe(0);
    expect((await dispatch('chef/a', capture('two', complete))).code).toBe(0);
    expect((await dispatch('chef/a', capture('three', complete))).code).toBe(1);
  });

  test('keeps the count in a durable file under the state directory, readable by a later run', async () => {
    await dispatch('chef/a', capture('one', complete));
    const file = JSON.parse(readFileSync(join(stateDirectory, 'design-rounds.json'), 'utf8')) as {
      branches: Record<string, { rounds: unknown[] }>;
    };
    expect(file.branches['chef/a']?.rounds).toHaveLength(1);
    const status = await run(['status', '--branch', 'chef/a', '--state-directory', stateDirectory]);
    expect(status.output).toBe('chef/a: 1 of 2 design-review rounds used.');
  });

  test('counts a branch named like an inherited key as an ordinary branch, and answers JSON', async () => {
    const result = await run([
      'dispatch',
      '--branch',
      'constructor',
      '--capture',
      capture('one', complete),
      '--state-directory',
      stateDirectory,
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, round: 1, counted: true });
  });

  test('refuses bad usage', async () => {
    await expect(run(['dispatch'])).rejects.toThrow('--branch is required');
    await expect(run(['nonsense', '--branch', 'x'])).rejects.toThrow('Usage');
  });
});
