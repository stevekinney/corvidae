/**
 * Tests for the application's coverage report, this workspace's `test:coverage`.
 *
 * `test:coverage` is `bun scripts/check-coverage-cli.ts`, so the script's exit status is this
 * command's. The first scenario runs the command line in a real child process with an LCOV report
 * of very low coverage and checks that it still exits zero; the measurement itself is replaced,
 * because running the suite under coverage inside the suite would measure nothing but itself.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '@lostgradient/testing';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';

import packageJson from '../package.json' with { type: 'json' };
import {
  measureUiCoverage,
  readUiCoverageReport,
  reportUiCoverage,
  uiCoverageExitCode,
  type StartUiCoverageRun,
} from './check-coverage-cli.ts';
import { UI_COVERAGE_DIRECTORY } from './check-coverage.ts';

/** One LCOV record for `file` with the given line and function counts. */
function lcovRecord(file: string, linesHit: number, linesFound: number): string {
  return [
    `SF:${file}`,
    'FNF:1',
    'FNH:1',
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    'end_of_record',
  ].join('\n');
}

const lowCoverage = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-coverage-report-'));
  try {
    const entry = join(directory, 'low-coverage.ts');
    await writeFile(
      entry,
      [
        `import { uiCoverageExitCode } from ${JSON.stringify(new URL('./check-coverage-cli.ts', import.meta.url).pathname)};`,
        // The command line's own last line, with the measurement replaced.
        `process.exitCode = await uiCoverageExitCode({`,
        `  runCoverage: async () => 0,`,
        `  readLcov: async () => ${JSON.stringify(lcovRecord('src/lib/client.ts', 1, 10))},`,
        `});`,
      ].join('\n'),
    );
    const child = spawnWithHangGuard([process.execPath, entry], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('src/lib | 10.00% | 100.00%');
    expect(stdout).toContain('OVERALL | 10.00% | 100.00%');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

let quiet: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of quiet) spy.mockRestore();
  quiet = [];
});

/** Keep the report out of the test output, and hand back what it wrote to stdout and stderr. */
function captureReportOutput(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  quiet = [
    spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(' '));
    }),
    spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(' '));
    }),
  ];
  return { logs, errors };
}

describe('the coverage report', () => {
  test('test:coverage runs the report, and exits zero however low the coverage is', () => {
    expect(packageJson.scripts['test:coverage']).toBe('bun scripts/check-coverage-cli.ts');
    rethrow(lowCoverage);
  });

  test('counts only this application’s files and names their areas', async () => {
    const { logs, errors } = captureReportOutput();
    const report = [
      lcovRecord('src/lib/client.ts', 9, 10),
      // Other workspaces' records share the report but not this application's numbers.
      lcovRecord('../../packages/weft/src/index.ts', 0, 50),
      lcovRecord('../../packages/weft/src/testing/promise-outcome.test-support.ts', 0, 5),
    ].join('\n');

    expect(
      await reportUiCoverage({ runCoverage: async () => 0, readLcov: async () => report }),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(logs).toContain('  src/lib | 90.00% | 100.00%');
    expect(logs).toContain('  OVERALL | 90.00% | 100.00%');
  });

  test('prints each area without comparing it with anything', async () => {
    const { logs, errors } = captureReportOutput();
    const report = [
      lcovRecord('src/lib/client.ts', 1, 10),
      lcovRecord('src/app/theme.svelte.ts', 4, 4),
    ].join('\n');

    expect(
      await uiCoverageExitCode({ runCoverage: async () => 0, readLcov: async () => report }),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toContain('  src/lib | 10.00% | 100.00%');
    expect(logs).toContain('  src/app | 100.00% | 100.00%');
  });

  test('fails when the measurement fails or writes no report', async () => {
    const { errors } = captureReportOutput();

    expect(await reportUiCoverage({ runCoverage: async () => 3 })).toBe(false);
    expect(errors[0]).toContain('exited with code 3');
    expect(
      await reportUiCoverage({ runCoverage: async () => 0, readLcov: async () => undefined }),
    ).toBe(false);
    expect(errors.at(-1)).toContain('found none');
  });

  test('reads the report when it exists, and starts the measurement from the application root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-coverage-report-'));
    try {
      const report = join(directory, 'lcov.info');
      expect(await readUiCoverageReport(report)).toBeUndefined();
      await writeFile(report, 'SF:src/index.ts\nend_of_record\n');
      expect(await readUiCoverageReport(report)).toBe('SF:src/index.ts\nend_of_record\n');

      const started: Parameters<StartUiCoverageRun>[] = [];
      const exitCode = await measureUiCoverage({
        coverageDirectory: directory,
        start: (command, options) => {
          started.push([command, options]);
          return { exited: Promise.resolve(7) };
        },
      });
      expect(exitCode).toBe(7);
      expect(started).toEqual([
        [
          ['bun', 'scripts/run-coverage.ts'],
          { cwd: join(import.meta.dir, '..'), stdout: 'inherit', stderr: 'inherit' },
        ],
      ]);
      // The previous report is removed before the run starts.
      expect(await readUiCoverageReport(report)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('measures from the default report directory and the default spawner when given no options', async () => {
    // `measureUiCoverage()` with nothing is how the command line runs it: it deletes the real
    // `coverage/ui` and spawns the whole suite. The spawner is replaced, so nothing runs, and a
    // report already there is moved aside for the call and put back after it.
    const reportDirectory = join(import.meta.dir, '..', UI_COVERAGE_DIRECTORY);
    const aside = `${reportDirectory}.aside-${process.pid}`;
    const hadReport = existsSync(reportDirectory);
    if (hadReport) await rename(reportDirectory, aside);
    const spawner = spyOn(Bun, 'spawn').mockImplementation((() => ({
      exited: Promise.resolve(5),
    })) as unknown as typeof Bun.spawn);
    try {
      expect(await measureUiCoverage()).toBe(5);
      expect(spawner).toHaveBeenCalledTimes(1);
      expect(spawner.mock.calls[0]?.[0]).toEqual(['bun', 'scripts/run-coverage.ts']);
      expect(existsSync(reportDirectory)).toBe(false);
    } finally {
      spawner.mockRestore();
      if (hadReport) await rename(aside, reportDirectory);
    }
  });
});
