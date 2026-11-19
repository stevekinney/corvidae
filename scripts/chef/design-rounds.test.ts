import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { ROUND_LIMIT, runRounds } from './design-rounds.ts';
import { UsageError } from './process-runner.ts';

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
  coverage: { complete: boolean; expected: number; missing?: unknown[] } | null,
): string {
  const directory = join(sandbox, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'summary.json'),
    JSON.stringify(coverage === null ? { captures: 3 } : { captures: 3, coverage }),
  );
  return directory;
}

const complete = { complete: true, expected: 3, missing: [] };

/** A head per capture directory, so each distinct capture below is a distinct commit. */
function headOf(directory: string): string {
  return createHash('sha1').update(directory).digest('hex');
}

/** The host lock stands in as a plain call: the lock only matters between concurrent processes. */
const dependencies = {
  withLock: <T>(_directory: string, operation: () => T) => Promise.resolve(operation()),
};

function dispatch(branch: string, directory: string, head = headOf(directory)) {
  return runRounds(
    [
      'dispatch',
      '--branch',
      branch,
      '--capture',
      directory,
      '--head',
      head,
      '--state-directory',
      stateDirectory,
    ],
    dependencies,
  );
}

async function codeOf(branch: string, directory: string): Promise<number> {
  const result = await dispatch(branch, directory);
  return result.code;
}

describe('design-rounds dispatch', () => {
  // spawn-free: the host lock is stood in by a plain call, so no process starts
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

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('counts per branch, so another branch still has its rounds', async () => {
    await dispatch('chef/a', capture('one', complete));
    await dispatch('chef/a', capture('two', complete));
    expect(await codeOf('chef/b', capture('three', complete))).toBe(0);
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('treats a repeated capture as the same round, not a new one', async () => {
    const directory = capture('one', complete);
    expect(await codeOf('chef/a', directory)).toBe(0);
    const again = await dispatch('chef/a', directory);
    expect(again.code).toBe(0);
    expect(again.output).toContain('already counted');
    expect(await codeOf('chef/a', capture('two', complete))).toBe(0);
    expect(await codeOf('chef/a', capture('three', complete))).toBe(1);
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('keys a round on the head, so recapturing a commit elsewhere cannot spend or reset rounds', async () => {
    const head = 'abcdef0';
    const first = await dispatch('chef/a', capture('one', complete), head);
    expect(first.code).toBe(0);
    const recaptured = await dispatch('chef/a', capture('again', complete), head);
    expect(recaptured.code).toBe(0);
    expect(recaptured.output).toContain(`already counted for head ${head}`);
    expect(await codeOf('chef/a', capture('two', complete))).toBe(0);
    expect(await codeOf('chef/a', capture('three', complete))).toBe(1);
    // Recapturing the first head after the rounds are spent changes nothing.
    const fourth = await dispatch('chef/a', capture('fourth', complete), head);
    expect(fourth.output).toContain('already counted');
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('names chef/capture-1920 when every missing capture is at 1920', async () => {
    const wide = capture('wide', {
      complete: false,
      expected: 6,
      missing: [{ width: 1920 }, { width: 1920 }],
    });
    const refused = await dispatch('chef/a', wide);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('1920 captures come from chef/capture-1920 (COR-2445)');
    const mixed = capture('mixed', {
      complete: false,
      expected: 6,
      missing: [{ width: 1920 }, { width: 375 }],
    });
    const other = await dispatch('chef/a', mixed);
    expect(other.output).not.toContain('capture-1920');
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('refuses a capture that expected nothing: an empty plan proves nothing', async () => {
    const empty = capture('empty', { complete: true, expected: 0, missing: [] });
    const refused = await dispatch('chef/a', empty);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('expected no captures');
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('counts only a round whose capture manifest was complete: coverage before counting', async () => {
    const incomplete = capture('partial', { complete: false, expected: 5, missing: [{}, {}] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await dispatch('chef/a', incomplete);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain('not counted');
      expect(refused.output).toContain('missing 2 declared state(s)');
    }
    const unplanned = await dispatch('chef/a', capture('unplanned', null));
    expect(unplanned.code).toBe(1);
    expect(unplanned.output).toContain('captured without --expect');
    expect(await codeOf('chef/a', join(sandbox, 'absent'))).toBe(1);
    // None of the refusals spent a round: both rounds are still there.
    expect(await codeOf('chef/a', capture('one', complete))).toBe(0);
    expect(await codeOf('chef/a', capture('two', complete))).toBe(0);
    expect(await codeOf('chef/a', capture('three', complete))).toBe(1);
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('keeps the count in a durable file under the state directory, readable by a later run', async () => {
    await dispatch('chef/a', capture('one', complete));
    const file = JSON.parse(readFileSync(join(stateDirectory, 'design-rounds.json'), 'utf8')) as {
      branches: Record<string, { rounds: unknown[] }>;
    };
    expect(file.branches['chef/a']?.rounds).toHaveLength(1);
    const status = await runRounds(
      ['status', '--branch', 'chef/a', '--state-directory', stateDirectory],
      dependencies,
    );
    expect(status.output).toBe('chef/a: 1 of 2 design-review rounds used.');
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('counts a branch named like an inherited key as an ordinary branch, and answers JSON', async () => {
    const result = await runRounds(
      [
        'dispatch',
        '--branch',
        'constructor',
        '--capture',
        capture('one', complete),
        '--head',
        'abcdef0',
        '--state-directory',
        stateDirectory,
        '--json',
      ],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, round: 1, counted: true });
  });

  // spawn-free: the host lock is stood in by a plain call, so no process starts
  test('refuses bad usage', async () => {
    const noBranch = await rejectionOf(runRounds(['dispatch'], dependencies));
    expect(noBranch).toBeInstanceOf(UsageError);
    expect((noBranch as Error).message).toContain('--branch is required');
    expect(
      await rejectionOf(runRounds(['nonsense', '--branch', 'x'], dependencies)),
    ).toBeInstanceOf(UsageError);
  });
});
