import { outcomeOf, rethrow, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureSourceState,
  loadExceedsLimit,
  NORMALIZED_CHILD_ENVIRONMENT,
  parseContainerMemoryLimit,
  parseLoadAverages,
  partitionPorcelainStatus,
  recordedChildEnvironment,
  waitForSettledLoad,
  type HostLoad,
} from './measure-playground-environment.ts';

describe('parseLoadAverages', () => {
  it('reads macOS uptime output', () => {
    expect(
      parseLoadAverages('14:02  up 3 days,  2:11, 9 users, load averages: 42.15 61.20 88.03'),
    ).toEqual({ oneMinute: 42.15, fiveMinutes: 61.2, fifteenMinutes: 88.03 });
  });

  it('reads Linux uptime output', () => {
    expect(
      parseLoadAverages(' 14:02:11 up 3 days,  2:11,  1 user,  load average: 0.52, 0.58, 0.59'),
    ).toEqual({ oneMinute: 0.52, fiveMinutes: 0.58, fifteenMinutes: 0.59 });
  });

  it('returns null for output without load averages', () => {
    expect(parseLoadAverages('uptime: unavailable')).toBeNull();
  });
});

describe('parseContainerMemoryLimit', () => {
  it('treats max as no limit', () => {
    expect(parseContainerMemoryLimit('max\n')).toEqual({ limited: false });
  });

  it('reads a byte limit', () => {
    expect(parseContainerMemoryLimit('8589934592\n')).toEqual({
      limited: true,
      bytes: 8_589_934_592,
    });
  });

  it('refuses an unrecognized value', () => {
    expect(() => parseContainerMemoryLimit('lots')).toThrow(RangeError);
  });
});

describe('partitionPorcelainStatus', () => {
  it('separates tracked changes from untracked paths', () => {
    expect(
      partitionPorcelainStatus(
        ' M applications/playground/src/page-bundle.ts\n?? applications/playground/scripts/new.ts\n',
      ),
    ).toEqual({
      dirtyPaths: ['applications/playground/src/page-bundle.ts'],
      untrackedPaths: ['applications/playground/scripts/new.ts'],
    });
  });
});

function hostLoad(oneMinute: number): HostLoad {
  return {
    capturedAt: '',
    uptime: '',
    loadAverages: { oneMinute, fiveMinutes: oneMinute, fifteenMinutes: oneMinute },
    logicalProcessors: 10,
  };
}

describe('loadExceedsLimit', () => {
  it('compares the one-minute load with factor times the logical processors', () => {
    expect(loadExceedsLimit(hostLoad(30), 3)).toBe(false);
    expect(loadExceedsLimit(hostLoad(30.5), 3)).toBe(true);
  });
});

describe('waitForSettledLoad', () => {
  it('starts at once under the limit', async () => {
    const wait = await waitForSettledLoad(3, { capture: () => hostLoad(12), now: () => 0 });
    expect(wait).toMatchObject({ thresholdOneMinute: 30, waitedMilliseconds: 0, checks: 1 });
  });

  it('waits through extreme load and records the wait', async () => {
    const readings = [250, 120, 29];
    let clock = 0;
    const reported: number[] = [];
    const wait = await waitForSettledLoad(3, {
      capture: () => hostLoad(readings.shift()!),
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
      intervalMilliseconds: 30_000,
      report: (load) => reported.push(load.loadAverages.oneMinute),
    });
    expect(reported).toEqual([250, 120]);
    expect(wait.checks).toBe(3);
    expect(wait.waitedMilliseconds).toBe(60_000);
    expect(wait.loadAtStart.loadAverages.oneMinute).toBe(29);
  });
});

/** The scenario runs real `git` and `captureSourceState`, so it runs at module scope. */
const untrackedContentIsFingerprinted = await outcomeOf(async () => {
  const repository = await mkdtemp(join(tmpdir(), 'measure-playground-source-'));

  async function git(...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', '-C', repository, ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
    });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  }

  try {
    await git('init', '-q');
    await git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'root',
    );
    await writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
    await git('add', '.gitignore');
    await git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'ignore',
    );
    expect(captureSourceState(repository).untrackedSha256).toBeNull();

    await writeFile(join(repository, 'ignored.txt'), 'not measured');
    expect(captureSourceState(repository).untrackedSha256).toBeNull();

    await writeFile(join(repository, 'added.ts'), 'export const value = 1;\n');
    const first = captureSourceState(repository).untrackedSha256;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(join(repository, 'added.ts'), 'export const value = 2;\n');
    expect(captureSourceState(repository).untrackedSha256).not.toBe(first);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

describe('captureSourceState untracked content (4274040383)', () => {
  it('fingerprints the contents of untracked, non-ignored files and ignores ignored ones', () =>
    rethrow(untrackedContentIsFingerprinted));
});

/** The scenario runs real `git` and `captureSourceState`, so it runs at module scope. */
const excludedResultsStayOutOfTheFingerprint = await outcomeOf(async () => {
  const repository = await mkdtemp(join(tmpdir(), 'measure-playground-exclusion-'));

  async function git(...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', '-C', repository, ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
    });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  }

  try {
    await git('init', '-q');
    await mkdir(join(repository, 'results'));
    await writeFile(join(repository, 'results', 'kept.json'), '{}\n');
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    await git('add', '.');
    await git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'root');
    const clean = captureSourceState(repository, ['results']);

    await writeFile(join(repository, 'results', 'kept.json'), '{"changed":true}\n');
    await writeFile(join(repository, 'results', 'baseline.json'), '{}\n');
    expect(captureSourceState(repository, ['results'])).toEqual(clean);

    await writeFile(join(repository, 'source.ts'), 'export const value = 2;\n');
    await writeFile(join(repository, 'added.ts'), 'export {};\n');
    const withSourceChange = captureSourceState(repository, ['results']);
    expect(withSourceChange.dirtyPaths).toEqual(['source.ts']);
    expect(withSourceChange.untrackedPaths).toEqual(['added.ts']);
    expect(withSourceChange.workingTreeDiffSha256).not.toBeNull();
    expect(withSourceChange.untrackedSha256).not.toBeNull();
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

describe('captureSourceState output exclusion (CIN-588 harness fix 1)', () => {
  it('leaves files under an excluded results directory out of every part of the fingerprint', () =>
    rethrow(excludedResultsStayOutOfTheFingerprint));
});

describe('NORMALIZED_CHILD_ENVIRONMENT (CIN-588 harness fix 2)', () => {
  it('covers every variable the Playground configuration reads', async () => {
    const source = await Bun.file(
      join(import.meta.dirname, '..', 'src', 'environment-configuration.ts'),
    ).text();
    const registered = [...source.matchAll(/env: '([A-Z0-9_]+)'/gu)].map((match) => match[1]!);
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered)
      expect(Object.keys(NORMALIZED_CHILD_ENVIRONMENT)).toContain(name);
  });

  it('removes everything but an empty component scope, recorded with null for removed', () => {
    const recorded = recordedChildEnvironment();
    expect(recorded['CINDER_TEST_COMPONENTS']).toBe('');
    for (const [name, value] of Object.entries(recorded)) {
      if (name !== 'CINDER_TEST_COMPONENTS') expect(value).toBeNull();
    }
  });
});

describe('waitForSettledLoad record-only (CIN-588 harness fix 5)', () => {
  it('records the load once and never waits when no factor is given', async () => {
    let slept = 0;
    const wait = await waitForSettledLoad(undefined, {
      capture: () => hostLoad(400),
      sleep: async () => {
        slept += 1;
      },
      now: () => 0,
    });
    expect(slept).toBe(0);
    expect(wait).toMatchObject({ thresholdOneMinute: null, waitedMilliseconds: 0, checks: 1 });
    expect(wait.loadAtStart.loadAverages.oneMinute).toBe(400);
  });
});
