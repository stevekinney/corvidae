/**
 * Tests for the UI's coverage gate, the second command of Weft's `test:coverage`.
 *
 * `test:coverage` is `bun scripts/check-coverage.ts && bun scripts/ui-coverage/check-coverage-cli.ts`,
 * so once the engine's gate passes, the script's exit status is this command's. The first scenario
 * runs the command line in a real child process with an LCOV report below a recorded floor and
 * checks that it exits non-zero; the measurement itself is replaced, because running the UI suite
 * under coverage inside the UI suite would measure nothing but itself.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import packageJson from '../../package.json' with { type: 'json' };
import { outcomeOf, rethrow } from '../../src/testing/module-scope-scenario.test-support.ts';
import { spawnWithHangGuard } from '../lib/hang-guard.ts';
import {
  checkUiCoverage,
  measureUiCoverage,
  readUiCoverageReport,
  uiCoverageExitCode,
  type StartUiCoverageRun,
} from './check-coverage-cli.ts';
import type { CoverageBaseline } from './coverage-baseline.ts';

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

/** A floor of 9 in 10 lines for `src/lib`, the area `src/ui/lib/*` files count toward. */
const floor: CoverageBaseline = {
  measuredAt: '2026-10-15T00:00:00.000Z',
  overall: { linesFound: 10, linesHit: 9, functionsFound: 1, functionsHit: 1 },
  areas: { 'src/lib': { linesFound: 10, linesHit: 9, functionsFound: 1, functionsHit: 1 } },
};

const belowFloor = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-ui-coverage-gate-'));
  try {
    const entry = join(directory, 'below-floor.ts');
    await writeFile(
      entry,
      [
        `import { uiCoverageExitCode } from ${JSON.stringify(new URL('./check-coverage-cli.ts', import.meta.url).pathname)};`,
        // The command line's own last line, with the measurement and the floor replaced.
        `process.exitCode = await uiCoverageExitCode({`,
        `  runCoverage: async () => 0,`,
        `  readLcov: async () => ${JSON.stringify(lcovRecord('src/ui/lib/client.ts', 1, 10))},`,
        `  resolveBaseline: () => ({ baseline: ${JSON.stringify(floor)}, platform: 'darwin' }),`,
        `});`,
      ].join('\n'),
    );
    const child = spawnWithHangGuard([process.execPath, entry], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('2 coverage regression(s) vs. the recorded baseline:');
    expect(stderr).toContain('src/lib lines: 10.00% < baseline 90.00%');
    expect(stderr).toContain('OVERALL lines: 10.00% < baseline 90.00%');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

let quiet: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of quiet) spy.mockRestore();
  quiet = [];
});

/** Keep the gate's report out of the test output, and hand back what it wrote to stderr. */
function captureGateOutput(): string[] {
  const errors: string[] = [];
  quiet = [
    spyOn(console, 'log').mockImplementation(() => undefined),
    spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(' '));
    }),
  ];
  return errors;
}

describe('the UI coverage gate', () => {
  test('test:coverage runs the UI gate after the engine gate, and exits non-zero below a floor', () => {
    expect(packageJson.scripts['test:coverage']).toBe(
      'bun scripts/check-coverage.ts && bun scripts/ui-coverage/check-coverage-cli.ts',
    );
    rethrow(belowFloor);
  });

  test('passes at the floor, counting only the UI’s files and naming their areas', async () => {
    const errors = captureGateOutput();
    const report = [
      lcovRecord('src/ui/lib/client.ts', 9, 10),
      // Engine and test-support records share the report but not the gate.
      lcovRecord('src/index.ts', 0, 50),
      lcovRecord('src/testing/promise-outcome.test-support.ts', 0, 5),
    ].join('\n');

    expect(
      await checkUiCoverage({
        runCoverage: async () => 0,
        readLcov: async () => report,
        resolveBaseline: () => ({ baseline: floor, platform: 'darwin' }),
      }),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  test('names each regressed area and each area new to the run, and fails on a recorded area missing from it', async () => {
    const errors = captureGateOutput();
    const report = [
      lcovRecord('src/ui/lib/client.ts', 1, 10),
      lcovRecord('src/ui/app/theme.svelte.ts', 4, 4),
    ].join('\n');
    const recorded: CoverageBaseline = {
      ...floor,
      areas: {
        ...floor.areas,
        'src/routes/retired': { linesFound: 1, linesHit: 1, functionsFound: 1, functionsHit: 1 },
      },
    };

    expect(
      await uiCoverageExitCode({
        runCoverage: async () => 0,
        readLcov: async () => report,
        resolveBaseline: () => ({ baseline: recorded, platform: 'darwin' }),
      }),
    ).toBe(1);
    expect(errors).toContain('  src/lib lines: 10.00% < baseline 90.00%');
    expect(console.log).toHaveBeenCalledWith(
      '\nNew area(s) with no recorded baseline yet (not gated): src/app',
    );
    const missingArea =
      "\nBaselined area(s) with no files in this run: src/routes/retired. A floor with nothing to measure gates nothing; restore the area's files to the run, or move its floor in scripts/ui-coverage/coverage-baseline.ts in the same change as the rename or removal.";
    expect(errors).toContain(missingArea);

    // Every measured area at or above its floor still fails while a recorded area has no files.
    errors.length = 0;
    expect(
      await uiCoverageExitCode({
        runCoverage: async () => 0,
        readLcov: async () => lcovRecord('src/ui/lib/client.ts', 9, 10),
        resolveBaseline: () => ({ baseline: recorded, platform: 'darwin' }),
      }),
    ).toBe(1);
    expect(errors).toEqual([missingArea]);
  });

  test('fails without gating when the measurement fails or writes no report', async () => {
    const errors = captureGateOutput();

    expect(await checkUiCoverage({ runCoverage: async () => 3 })).toBe(false);
    expect(errors[0]).toContain('exited with code 3');
    expect(
      await checkUiCoverage({ runCoverage: async () => 0, readLcov: async () => undefined }),
    ).toBe(false);
    expect(errors.at(-1)).toContain('found none');
  });

  test('reads the report when it exists, and starts the measurement from Weft’s root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weft-ui-coverage-report-'));
    try {
      const report = join(directory, 'lcov.info');
      expect(await readUiCoverageReport(report)).toBeUndefined();
      await writeFile(report, 'SF:src/ui/index.ts\nend_of_record\n');
      expect(await readUiCoverageReport(report)).toBe('SF:src/ui/index.ts\nend_of_record\n');

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
          ['bun', 'scripts/ui-coverage/run-coverage.ts'],
          { cwd: join(import.meta.dir, '..', '..'), stdout: 'inherit', stderr: 'inherit' },
        ],
      ]);
      // The previous report is removed before the run starts.
      expect(await readUiCoverageReport(report)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
