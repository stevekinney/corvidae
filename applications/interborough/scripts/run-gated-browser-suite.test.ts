/**
 * The batch validate's Interborough browser run (`scripts/run-gated-browser-suite.ts`): it picks a
 * free block of ports, never lets Playwright reuse a server, and passes Playwright's exit code on.
 */
import { describe, expect, test } from 'bun:test';

import { END_TO_END_PORT_COUNT } from './environment-configuration.ts';
import {
  blockIsFree,
  findFreePortBlock,
  type GatedRunEnvironment,
  runGatedBrowserSuite,
} from './run-gated-browser-suite.ts';

function fakeEnvironment(options: {
  readonly isFree?: (port: number) => boolean;
  readonly requestedPort?: number;
  readonly exitCode?: number;
}): {
  readonly environment: GatedRunEnvironment;
  readonly errors: string[];
  readonly runs: { command: readonly string[]; variables: Record<string, string> }[];
} {
  const errors: string[] = [];
  const runs: { command: readonly string[]; variables: Record<string, string> }[] = [];
  return {
    errors,
    runs,
    environment: {
      standardError: (text) => void errors.push(text),
      portIsFree: options.isFree ?? (() => true),
      requestedPort: options.requestedPort,
      run: async (command, variables) => {
        runs.push({ command, variables });
        return options.exitCode ?? 0;
      },
    },
  };
}

describe('findFreePortBlock', () => {
  test('answers a block whose every port is free', () => {
    const first = findFreePortBlock(
      END_TO_END_PORT_COUNT,
      () => true,
      () => 0.5,
    );
    expect(first).toBeNumber();
    expect(blockIsFree(first ?? 0, END_TO_END_PORT_COUNT, () => true)).toBe(true);
  });

  test('skips a block with one taken port in the middle and answers another', () => {
    const draws = [0, 0.5];
    const firstBlock = findFreePortBlock(
      7,
      () => true,
      () => 0,
    );
    if (firstBlock === undefined) throw new Error('expected a block');
    const taken = firstBlock + 3;
    const first = findFreePortBlock(
      7,
      (port) => port !== taken,
      () => draws.shift() ?? 0.9,
    );
    expect(first).toBeNumber();
    expect(first).not.toBe(firstBlock);
    expect(blockIsFree(first ?? 0, 7, (port) => port !== taken)).toBe(true);
  });

  test('gives up when no block is free', () => {
    expect(findFreePortBlock(7, () => false)).toBeUndefined();
  });
});

describe('runGatedBrowserSuite', () => {
  test('runs the chromium project on a free block with server reuse refused', async () => {
    const { environment, runs } = fakeEnvironment({});
    expect(await runGatedBrowserSuite(['--grep', 'chat'], environment)).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toEqual([
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      '--project=chromium',
      '--grep',
      'chat',
    ]);
    expect(runs[0]?.variables['INTERBOROUGH_E2E_FRESH_SERVER']).toBe('1');
    expect(Number(runs[0]?.variables['INTERBOROUGH_E2E_PORT'])).toBeGreaterThan(1024);
  });

  test('passes a failing exit code through', async () => {
    const { environment } = fakeEnvironment({ exitCode: 1 });
    expect(await runGatedBrowserSuite([], environment)).toBe(1);
  });

  test('exits 2 without running when no block is free', async () => {
    const { environment, errors, runs } = fakeEnvironment({ isFree: () => false });
    expect(await runGatedBrowserSuite([], environment)).toBe(2);
    expect(runs).toHaveLength(0);
    expect(errors.join('')).toContain('no block of 7 free consecutive ports');
  });

  test('honors a requested port only when its whole block is free', async () => {
    const free = fakeEnvironment({ requestedPort: 31000 });
    expect(await runGatedBrowserSuite([], free.environment)).toBe(0);
    expect(free.runs[0]?.variables['INTERBOROUGH_E2E_PORT']).toBe('31000');

    const taken = fakeEnvironment({ requestedPort: 31000, isFree: (port) => port !== 31003 });
    expect(await runGatedBrowserSuite([], taken.environment)).toBe(2);
    expect(taken.runs).toHaveLength(0);
    expect(taken.errors.join('')).toContain('never reuses a server');
  });
});
