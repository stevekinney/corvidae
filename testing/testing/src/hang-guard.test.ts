import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import {
  afterAwakeTime,
  runWithHangGuard,
  spawnWithHangGuard,
  withoutAutoInstall,
} from './hang-guard.ts';
import { outcomeOf, rethrow } from './helpers/module-scope-outcome.ts';

/**
 * Resolves with the real milliseconds until `afterAwakeTime` fired. Given `within`, resolves
 * `undefined` instead if it had not by then: a window only a test that proves the guard does NOT
 * fire uses, because a loaded host can only delay a tick, never bring it forward. A test that proves
 * it fires passes none and waits for it, so no load can fail it.
 */
function firedWithin(
  milliseconds: number,
  within: number | undefined,
  options: Parameters<typeof afterAwakeTime>[2],
): Promise<number | undefined> {
  const started = performance.now();
  return new Promise((resolve) => {
    const cancel = afterAwakeTime(
      milliseconds,
      () => {
        clearTimeout(limit);
        resolve(performance.now() - started);
      },
      options,
    );
    const limit =
      within === undefined
        ? undefined
        : setTimeout(() => {
            cancel();
            resolve(undefined);
          }, within);
  });
}

describe('afterAwakeTime', () => {
  it('fires once the budget of steady ticks is spent', async () => {
    const fired = await firedWithin(100, undefined, { tickMilliseconds: 10 });
    expect(fired).toBeGreaterThanOrEqual(100);
  });

  it('credits a gap the process did not live through as one tick', async () => {
    // The injected clock jumps ten minutes on its second reading, as it does across a system
    // sleep. The budget is 200 ms of 10 ms ticks, so a clock-based guard would fire at the jump.
    let readings = 0;
    const now = (): number => performance.now() + (++readings >= 2 ? 600_000 : 0);
    expect(await firedWithin(200, 120, { tickMilliseconds: 10, now })).toBeUndefined();
    readings = 0;
    expect(await firedWithin(200, undefined, { tickMilliseconds: 10, now })).toBeGreaterThanOrEqual(
      190,
    );
  });

  it('falls back to its real backstop at the full budget while fake timers are active', async () => {
    // Fake timers freeze the clock, so no tick can credit anything. The backstop still fires.
    const frozen = performance.now();
    const fired = await firedWithin(100, undefined, {
      tickMilliseconds: 10,
      now: () => frozen,
      fakeTimersActive: () => true,
    });
    expect(fired).toBeGreaterThanOrEqual(100);
  });

  it('resumes ticking when fake timers end before the budget is spent', async () => {
    // Fake timers are reported on the first look only: the first tick finds them and stops, and the
    // backstop finds real timers and resumes. Counting looks, not milliseconds, keeps the order of
    // the two independent of how late a loaded host runs either timer.
    let looks = 0;
    const fired = await firedWithin(100, undefined, {
      tickMilliseconds: 10,
      fakeTimersActive: () => ++looks === 1,
    });
    expect(fired).toBeGreaterThanOrEqual(100);
  });

  it('keeps its ticks out of a leak tracker that wraps the global setTimeout', async () => {
    // Ventriloquist's conformance cells and `trackTimers` count what the global schedules while
    // the code under test runs; a guard ticking through it was reported as that code's leak.
    const original = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      scheduled += 1;
      return original(...args);
    }) as typeof setTimeout;
    try {
      let fired = false;
      // hang-guard-self-test: the guard under test is the thing being proven to fire, so its budget is the subject
      afterAwakeTime(30, () => (fired = true), { tickMilliseconds: 5 });
      while (!fired) await Bun.sleep(5);
    } finally {
      globalThis.setTimeout = original;
    }
    expect(scheduled).toBe(0);
  });

  it('never fires once cancelled', async () => {
    let fired = false;
    // hang-guard-self-test: the guard under test is the thing being proven to fire, so its budget is the subject
    const cancel = afterAwakeTime(20, () => (fired = true), { tickMilliseconds: 5 });
    cancel();
    await quietFor(60);
    expect(fired).toBe(false);
  });
});

// Each process scenario runs once at module scope, off Bun's per-test clock.
const killsAHungChild = await outcomeOf(async () => {
  // hang-guard-self-test: the guard under test is the thing being proven to fire, so its budget is the subject
  const child = spawnWithHangGuard(['sleep', '30'], { hangGuardMilliseconds: 200 });
  expect(await child.exited).not.toBe(0);
  expect(child.signalCode).toBe('SIGTERM');
});

const usesTheKillSignal = await outcomeOf(async () => {
  // hang-guard-self-test: the guard under test is the thing being proven to fire, so its budget is the subject
  const child = spawnWithHangGuard(['sleep', '30'], {
    hangGuardMilliseconds: 200,
    killSignal: 'SIGKILL',
  });
  await child.exited;
  expect(child.signalCode).toBe('SIGKILL');
});

const leavesAFinishedChildAlone = await outcomeOf(async () => {
  const result = await runWithHangGuard(['sh', '-c', 'printf out; printf err >&2; exit 3']);
  expect(result).toMatchObject({ exitCode: 3, signalCode: null, success: false });
  expect(result.stdout.toString()).toBe('out');
  expect(result.stderr.toString()).toBe('err');
});

describe('spawnWithHangGuard', () => {
  it('kills a child that outlives its guard with SIGTERM', () => rethrow(killsAHungChild));
  it('kills with the given killSignal', () => rethrow(usesTheKillSignal));
});

describe('runWithHangGuard', () => {
  it('resolves with the exit status and both streams', () => rethrow(leavesAFinishedChildAlone));
});

describe('withoutAutoInstall', () => {
  const bun = process.execPath;

  it.each([
    ['a script', [bun, 'script.ts', 'argument'], [bun, '--no-install', 'script.ts', 'argument']],
    ['a test run', ['bun', 'test', 'a.test.ts'], ['bun', '--no-install', 'test', 'a.test.ts']],
    [
      'a script run',
      [bun, 'run', '--cwd', 'x', 'name'],
      [bun, '--no-install', 'run', '--cwd', 'x', 'name'],
    ],
    ['a build', ['bun', 'build', 'entry.ts'], ['bun', '--no-install', 'build', 'entry.ts']],
    ['a watched script', [bun, '--watch', 'a.ts'], [bun, '--no-install', '--watch', 'a.ts']],
    ['an eval', [bun, '--eval', 'install'], [bun, '--no-install', '--eval', 'install']],
    ['no arguments', [bun], [bun, '--no-install']],
  ])('adds --no-install in front of %s', (_name, command, expected) => {
    expect(withoutAutoInstall(command)).toEqual(expected);
  });

  it.each([
    ['an install', [bun, 'install', '--frozen-lockfile']],
    ['an add', ['bun', 'add', 'zod']],
    ['a package-manager command after a flag', [bun, '--cwd', 'dir', 'pm', 'pack']],
    ['bunx-style x', [bun, 'x', 'prettier']],
    ['a command that already chose', [bun, '--no-install', 'a.ts']],
    ['an explicit install mode', [bun, '--install=auto', 'a.ts']],
    ['a command that is not Bun', ['git', 'status']],
    ['an empty command', []],
  ])('leaves %s as it is', (_name, command) => {
    expect(withoutAutoInstall(command)).toEqual(command);
  });

  it('does not change its argument', () => {
    const command = [bun, 'a.ts'];
    withoutAutoInstall(command);
    expect(command).toEqual([bun, 'a.ts']);
  });
});

// A module written to the system temp directory has no `node_modules` above it, so Bun resolves a
// package it imports by installing it from the registry. The registry here is a local server that
// counts requests, so this proves the behavior without touching the network.
const autoInstallProbe = await outcomeOf(async () => {
  const requests: string[] = [];
  const registry = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return new Response('{}', { status: 404 });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-auto-install-'));
  try {
    const entry = join(directory, 'fixture.ts');
    await writeFile(entry, "import 'corvidae-no-such-package-for-the-auto-install-probe';\n");
    const environment = {
      ...process.env,
      BUN_CONFIG_REGISTRY: `http://127.0.0.1:${registry.port}/`,
    };

    // The control: asking for auto-install by hand reaches the registry, so the probe can see it.
    const installing = await runWithHangGuard([process.execPath, '--install=auto', entry], {
      cwd: directory,
      env: environment,
    });
    expect(installing.success).toBe(false);
    expect(requests.length).toBeGreaterThan(0);

    // The helper's default: the same fixture fails to resolve and the registry is never asked.
    requests.length = 0;
    const resolving = await runWithHangGuard([process.execPath, entry], {
      cwd: directory,
      env: environment,
    });
    expect(resolving.success).toBe(false);
    expect(resolving.stderr.toString()).toContain('Cannot find package');
    expect(requests).toEqual([]);
  } finally {
    registry.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

describe('a Bun child started through the hang guard', () => {
  it('never auto-installs a package it cannot resolve', () => rethrow(autoInstallProbe));
});
