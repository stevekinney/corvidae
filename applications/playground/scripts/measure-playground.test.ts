import { outcomeOf, rethrow, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from '../src/playground-paths.ts';
import {
  isPortListening,
  microsecondsFrom,
  NORMALIZED_CHILD_ENVIRONMENT,
  parseCommandLine,
  PHASES,
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
      maximumLoadFactor: 3,
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
  const child = Bun.spawn(['true'], { timeout: SCENARIO_HANG_GUARD_MILLISECONDS });
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
