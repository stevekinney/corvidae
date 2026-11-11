/**
 * Runs the application's coverage measurement and prints each area's coverage. It is this
 * workspace's `test:coverage`, so it reports and never fails on a number: it exits non-zero only
 * when the measurement itself fails or writes no report.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  aggregateByArea,
  overallTotals,
  parseLcov,
  renderAreaTable,
  UI_COVERAGE_DIRECTORY,
  uiCoverageRecords,
} from './check-coverage.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..');
const COVERAGE_DIRECTORY = join(PACKAGE_ROOT, UI_COVERAGE_DIRECTORY);
const LCOV_PATH = join(COVERAGE_DIRECTORY, 'lcov.info');

export type UiCoverageReportDependencies = {
  /** Runs the measurement and resolves to its exit code. Defaults to {@link measureUiCoverage}. */
  runCoverage?: () => Promise<number>;
  /** The measurement's LCOV report, or `undefined` when it wrote none. */
  readLcov?: () => Promise<string | undefined>;
};

/** The one call {@link measureUiCoverage} makes to start the measurement; `Bun.spawn` by default. */
export type StartUiCoverageRun = (
  command: string[],
  options: { cwd: string; stdout: 'inherit'; stderr: 'inherit' },
) => { exited: Promise<number> };

/** Remove the previous report, then run `run-coverage.ts` from the application root; resolves to its exit code. */
export async function measureUiCoverage({
  coverageDirectory = COVERAGE_DIRECTORY,
  start = Bun.spawn,
}: { coverageDirectory?: string; start?: StartUiCoverageRun } = {}): Promise<number> {
  await rm(coverageDirectory, { recursive: true, force: true });
  return start(['bun', 'scripts/run-coverage.ts'], {
    cwd: PACKAGE_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited;
}

/** The LCOV report at `path`, or `undefined` when the measurement wrote none. */
export async function readUiCoverageReport(path = LCOV_PATH): Promise<string | undefined> {
  const report = Bun.file(path);
  return (await report.exists()) ? report.text() : undefined;
}

/** Measure the UI's coverage and print each area's numbers; `true` when the measurement produced a report. */
export async function reportUiCoverage(
  dependencies: UiCoverageReportDependencies = {},
): Promise<boolean> {
  console.log('Running `bun scripts/run-coverage.ts`…');
  const exitCode = await (dependencies.runCoverage ?? measureUiCoverage)();
  if (exitCode !== 0) {
    console.error(
      `\n\`bun scripts/run-coverage.ts\` exited with code ${exitCode}; the coverage report does not run against a failing or crashed test process.`,
    );
    console.error('Fix the failing or crashing tests first, then re-run `bun run test:coverage`.');
    return false;
  }

  const lcovContent = await (dependencies.readLcov ?? readUiCoverageReport)();
  if (lcovContent === undefined) {
    console.error(
      `\nExpected an LCOV report at ${LCOV_PATH} but found none. Was \`run-coverage.ts\` changed to drop \`--coverage-reporter=lcov\`?`,
    );
    return false;
  }

  // The run executes from the application root, so the report also carries the files of the
  // workspaces its tests reach through `@lostgradient/weft` and the rest. Those belong to their
  // own reports; keep only the application's files.
  const records = uiCoverageRecords(parseLcov(lcovContent));
  const areas = aggregateByArea(records);
  areas.set('OVERALL', overallTotals(records));

  console.log('\nCoverage by area:');
  for (const line of renderAreaTable(areas)) {
    console.log(`  ${line}`);
  }
  return true;
}

/** The command line's exit code: 1 when the measurement failed or wrote no report, 0 otherwise. */
export async function uiCoverageExitCode(
  dependencies: UiCoverageReportDependencies = {},
): Promise<number> {
  return (await reportUiCoverage(dependencies)) ? 0 : 1;
}

// `exitCode` rather than `process.exit()`, so a failing run's output reaches a pipe in full.
if (import.meta.main) process.exitCode = await uiCoverageExitCode();
