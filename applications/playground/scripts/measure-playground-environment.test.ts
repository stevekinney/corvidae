import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureSourceState,
  loadExceedsLimit,
  parseContainerMemoryLimit,
  parseLoadAverages,
  partitionPorcelainStatus,
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

describe('captureSourceState untracked content (4274040383)', () => {
  let repository: string | undefined;
  afterEach(async () => {
    if (repository !== undefined) await rm(repository, { recursive: true, force: true });
  });

  async function git(...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', '-C', repository!, ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  }

  it('fingerprints the contents of untracked, non-ignored files and ignores ignored ones', async () => {
    repository = await mkdtemp(join(tmpdir(), 'measure-playground-source-'));
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
  });
});
