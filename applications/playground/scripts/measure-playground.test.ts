import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from '../src/playground-paths.ts';
import { microsecondsFrom, parseCommandLine, PHASES } from './measure-playground.ts';

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

describe('microsecondsFrom', () => {
  it('turns the bigint cpuTime a subprocess reports into a serializable number', async () => {
    const child = Bun.spawn(['true']);
    await child.exited;
    const user: unknown = child.resourceUsage()?.cpuTime.user;
    expect(typeof user).toBe('bigint');
    const value = microsecondsFrom(user as bigint);
    expect(typeof value).toBe('number');
    expect(() => JSON.stringify({ value })).not.toThrow();
  });

  it('passes a number through', () => {
    expect(microsecondsFrom(42)).toBe(42);
  });
});
