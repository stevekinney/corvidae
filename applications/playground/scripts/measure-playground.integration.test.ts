import { outcomeOf, rethrow } from '@lostgradient/testing';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from '../src/playground-paths.ts';
import { NORMALIZED_CHILD_ENVIRONMENT } from './measure-playground-environment.ts';
import {
  isPortListening,
  microsecondsFrom,
  outputExclusions,
  parseCommandLine,
  PHASES,
  prerequisitesThenEnvironment,
  readinessWaitExceeded,
  SERVER_READY_DEADLINE_MILLISECONDS,
} from './measure-playground.ts';

const now = new Date('2026-10-13T12:34:56.789Z');

describe('parseCommandLine', () => {
  it('defaults a run to every phase, three pairs, and five cycles in a run-owned work directory', () => {
    expect(
      parseCommandLine(['run', '--label', 'baseline', '--output', '/tmp/out.json'], now),
    ).toEqual({
      command: 'run',
      label: 'baseline',
      output: '/tmp/out.json',
      workDirectory: join(
        REPOSITORY_ROOT,
        'tmp',
        'playground-measurements',
        'baseline-2026-10-13T12-34-56-789Z',
      ),
      phases: [...PHASES],
      pairs: 3,
      playwrightPairs: 1,
      cycles: 5,
      serverPort: 5610,
    });
  });

  it('narrows phases and counts for a smoke run', () => {
    const options = parseCommandLine(
      [
        'run',
        '--label',
        'candidate',
        '--output',
        'out.json',
        '--phases',
        'static-export, server-ready',
        '--pairs',
        '1',
        '--cycles',
        '1',
      ],
      now,
    );
    expect(options).toMatchObject({
      phases: ['static-export', 'server-ready'],
      pairs: 1,
      cycles: 1,
    });
  });

  it('refuses unknown phases, bad counts, unsafe labels, and missing output', () => {
    expect(() =>
      parseCommandLine(['run', '--label', 'x', '--output', 'o', '--phases', 'deploy']),
    ).toThrow('--phases');
    expect(() =>
      parseCommandLine(['run', '--label', 'x', '--output', 'o', '--pairs', '0']),
    ).toThrow('--pairs');
    expect(() => parseCommandLine(['run', '--label', '../x', '--output', 'o'])).toThrow('--label');
    expect(() => parseCommandLine(['run', '--label', 'x'])).toThrow('--output');
    expect(() => parseCommandLine(['measure'])).toThrow('Unknown command');
    expect(() =>
      parseCommandLine(['run', '--label', 'x', '--output', 'o', '--maximum-load-factor', '0']),
    ).toThrow('--maximum-load-factor');
  });

  it('reads a comparison', () => {
    expect(
      parseCommandLine(['compare', '--baseline', '/a.json', '--candidate', '/b.json']),
    ).toEqual({
      command: 'compare',
      baseline: '/a.json',
      candidate: '/b.json',
      output: undefined,
    });
    expect(() => parseCommandLine(['compare', '--baseline', '/a.json'])).toThrow('--candidate');
  });
});

/** Reading `cpuTime` needs a real subprocess, so the body runs at module scope. */
const subprocessCpuTimeBecomesANumber = await outcomeOf(async () => {
  const child = spawnWithHangGuard(['true']);
  await child.exited;
  const user: unknown = child.resourceUsage()?.cpuTime.user;
  expect(typeof user).toBe('bigint');
  const value = microsecondsFrom(user as bigint);
  expect(typeof value).toBe('number');
  expect(() => JSON.stringify({ value })).not.toThrow();
});

describe('microsecondsFrom', () => {
  it('turns the bigint cpuTime a subprocess reports into a serializable number', () =>
    rethrow(subprocessCpuTimeBecomesANumber));

  it('passes a number through', () => {
    expect(microsecondsFrom(42)).toBe(42);
  });
});

describe('isPortListening (4274040404)', () => {
  it('detects a listener with a Bun connection probe, without lsof', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });
    try {
      expect(await isPortListening(listener.port)).toBe(true);
    } finally {
      listener.stop(true);
    }
    expect(await isPortListening(listener.port)).toBe(false);
  });
});

describe('NORMALIZED_CHILD_ENVIRONMENT (4274040392)', () => {
  it('removes an inherited NODE_ENV and component scope from every measured child', () => {
    expect('NODE_ENV' in NORMALIZED_CHILD_ENVIRONMENT).toBe(true);
    expect(NORMALIZED_CHILD_ENVIRONMENT['NODE_ENV']).toBeUndefined();
    expect(NORMALIZED_CHILD_ENVIRONMENT['CINDER_TEST_COMPONENTS']).toBe('');
  });
});

describe('outputExclusions (CIN-588 harness fix 1)', () => {
  it('excludes the output file directory and an in-repository work directory', () => {
    expect(
      outputExclusions(
        '/repository/applications/playground/docs/decisions/cin-588-results/baseline.json',
        '/repository/tmp/playground-measurements/baseline',
        '/repository',
      ),
    ).toEqual([
      'applications/playground/docs/decisions/cin-588-results',
      'tmp/playground-measurements/baseline',
    ]);
  });

  it('ignores directories outside the repository', () => {
    expect(outputExclusions('/elsewhere/out.json', '/scratch/work', '/repository')).toEqual([]);
  });
});

describe('prerequisitesThenEnvironment (CIN-588 harness fix 4)', () => {
  it('captures the environment only after the install prerequisite finishes', async () => {
    let installedSvelte = '5.0.0';
    const environment = await prerequisitesThenEnvironment(
      async () => {
        // load-proof: the prerequisite is an in-memory async function, and the assertion only orders it before the environment read
        await Bun.sleep(1);
        installedSvelte = '5.1.0';
      },
      () => ({ svelte: installedSvelte }),
    );
    expect(environment).toEqual({ svelte: '5.1.0' });
  });

  it('does not capture an environment when the prerequisite throws', async () => {
    let captured = false;
    const attempt = prerequisitesThenEnvironment(
      () => Promise.reject(new Error('install failed')),
      () => {
        captured = true;
        return {};
      },
    );
    let message = '';
    try {
      await attempt;
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('install failed');
    expect(captured).toBe(false);
  });
});

describe('record-only load gate by default (CIN-588 harness fix 5)', () => {
  it('sets no load factor unless one is asked for', () => {
    const options = parseCommandLine(['run', '--label', 'baseline', '--output', 'out.json']);
    expect(options.command === 'run' && options.maximumLoadFactor).toBeUndefined();
    const gated = parseCommandLine([
      'run',
      '--label',
      'baseline',
      '--output',
      'out.json',
      '--maximum-load-factor',
      '3',
    ]);
    expect(gated.command === 'run' && gated.maximumLoadFactor).toBe(3);
  });
});

describe('server readiness cutoff (CIN-588, owner-approved 2026-10-15)', () => {
  it('is a 900 s measurement censor', () => {
    expect(SERVER_READY_DEADLINE_MILLISECONDS).toBe(900_000);
  });

  it('keeps waiting for a readiness slower than the old 300 s cutoff but inside 900 s', () => {
    expect(readinessWaitExceeded(450_000)).toBe(false);
    expect(readinessWaitExceeded(900_000)).toBe(false);
  });

  it('stops waiting, so the sample fails, only past 900 s', () => {
    expect(readinessWaitExceeded(900_001)).toBe(true);
  });
});
