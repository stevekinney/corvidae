/**
 * Runs the UI's coverage measurement and applies the recorded ratchet. It is the second command of
 * Weft's `test:coverage`, after the engine's 100% gate (`scripts/check-coverage.ts`), so a UI floor
 * that is not met fails `test:coverage`, and through it the root `bun run coverage`.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  aggregateByArea,
  findRegressions,
  formatPercentage,
  overallTotals,
  parseLcov,
  renderAreaTable,
  resolveBaselineForPlatform,
  UI_COVERAGE_DIRECTORY,
  uiCoverageRecords,
} from './check-coverage.ts';
import type { AreaCoverage } from './coverage-baseline.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const COVERAGE_DIRECTORY = join(PACKAGE_ROOT, UI_COVERAGE_DIRECTORY);
const LCOV_PATH = join(COVERAGE_DIRECTORY, 'lcov.info');

export type UiCoverageGateDependencies = {
  /** Runs the measurement and resolves to its exit code. Defaults to {@link measureUiCoverage}. */
  runCoverage?: () => Promise<number>;
  /** The measurement's LCOV report, or `undefined` when it wrote none. */
  readLcov?: () => Promise<string | undefined>;
  /** The baseline to gate against. Defaults to the current platform's recorded floor. */
  resolveBaseline?: typeof resolveBaselineForPlatform;
};

/** The one call {@link measureUiCoverage} makes to start the measurement; `Bun.spawn` by default. */
export type StartUiCoverageRun = (
  command: string[],
  options: { cwd: string; stdout: 'inherit'; stderr: 'inherit' },
) => { exited: Promise<number> };

/** Remove the previous report, then run `run-coverage.ts` from Weft's root; resolves to its exit code. */
export async function measureUiCoverage({
  coverageDirectory = COVERAGE_DIRECTORY,
  start = Bun.spawn,
}: { coverageDirectory?: string; start?: StartUiCoverageRun } = {}): Promise<number> {
  await rm(coverageDirectory, { recursive: true, force: true });
  return start(['bun', 'scripts/ui-coverage/run-coverage.ts'], {
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

/** Measure the UI's coverage and compare it with the recorded floors; `true` when none regressed. */
export async function checkUiCoverage(
  dependencies: UiCoverageGateDependencies = {},
): Promise<boolean> {
  console.log('Running `bun scripts/ui-coverage/run-coverage.ts`…');
  const exitCode = await (dependencies.runCoverage ?? measureUiCoverage)();
  if (exitCode !== 0) {
    console.error(
      `\n\`bun scripts/ui-coverage/run-coverage.ts\` exited with code ${exitCode} — the coverage gate does not run against a failing or crashed test process.`,
    );
    console.error('Fix the failing/crashing tests first, then re-run `bun run test:coverage`.');
    return false;
  }

  const lcovContent = await (dependencies.readLcov ?? readUiCoverageReport)();
  if (lcovContent === undefined) {
    console.error(
      `\nExpected an LCOV report at ${LCOV_PATH} but found none — coverage cannot be gated. Was \`run-coverage.ts\` changed to drop \`--coverage-reporter=lcov\`?`,
    );
    return false;
  }

  // The run executes from Weft's root, so the report also carries the engine files UI tests reach
  // through `@lostgradient/weft`. Those belong to the engine's own gate; keep only the UI's files,
  // named in the layout the floors were recorded in.
  const records = uiCoverageRecords(parseLcov(lcovContent));
  const currentAreas = aggregateByArea(records);
  currentAreas.set('OVERALL', overallTotals(records));

  const gate = (dependencies.resolveBaseline ?? resolveBaselineForPlatform)(currentAreas);
  if (gate.baseline === null) return true;
  const { baseline, platform } = gate;

  const baselineAreas = new Map<string, AreaCoverage>(Object.entries(baseline.areas));
  baselineAreas.set('OVERALL', baseline.overall);

  console.log(
    `\nCoverage by area (${platform}), current vs. the baseline recorded ${baseline.measuredAt}:`,
  );
  for (const line of renderAreaTable(currentAreas, baselineAreas)) {
    console.log(`  ${line}`);
  }

  const newAreas = [...currentAreas.keys()].filter((area) => !baselineAreas.has(area));
  if (newAreas.length > 0) {
    console.log(`\nNew area(s) with no recorded baseline yet (not gated): ${newAreas.join(', ')}`);
  }
  const droppedAreas = [...baselineAreas.keys()].filter(
    (area) => area !== 'OVERALL' && !currentAreas.has(area),
  );
  if (droppedAreas.length > 0) {
    console.log(
      `\nBaselined area(s) with no files in this run (rename/removal? not gated): ${droppedAreas.join(', ')}`,
    );
  }

  const regressions = findRegressions(currentAreas, baselineAreas);
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} coverage regression(s) vs. the recorded baseline:`);
    for (const regression of regressions) {
      console.error(
        `  ${regression.area} ${regression.metric}: ${formatPercentage(regression.currentPercentage)} < baseline ${formatPercentage(regression.baselinePercentage)}`,
      );
    }
    console.error(
      '\nCoverage dropped below the recorded floor in scripts/ui-coverage/coverage-baseline.ts. Add tests to restore it, or — if the drop is an intentional, reviewed tradeoff — raise it in the PR description and update the baseline in the same PR.',
    );
    return false;
  }

  console.log('\nCoverage gate passed — no area dropped below its recorded baseline.');
  return true;
}

/** The command line's exit code: 1 when the gate fails, 0 when it passes. */
export async function uiCoverageExitCode(
  dependencies: UiCoverageGateDependencies = {},
): Promise<number> {
  return (await checkUiCoverage(dependencies)) ? 0 : 1;
}

// `exitCode` rather than `process.exit()`, so a failing run's output reaches a pipe in full.
if (import.meta.main) process.exitCode = await uiCoverageExitCode();
