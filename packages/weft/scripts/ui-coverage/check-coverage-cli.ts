/** Runs the package coverage measurement and applies the recorded ratchet. */
import { $ } from 'bun';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  aggregateByArea,
  findRegressions,
  formatPercentage,
  isPackageLocalFile,
  overallTotals,
  parseLcov,
  renderAreaTable,
  resolveBaselineForPlatform,
} from './check-coverage.ts';
import type { AreaCoverage } from './coverage-baseline.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const COVERAGE_DIRECTORY = join(REPO_ROOT, 'coverage');
const LCOV_PATH = join(COVERAGE_DIRECTORY, 'lcov.info');

async function main(): Promise<boolean> {
  await rm(COVERAGE_DIRECTORY, { recursive: true, force: true });

  console.log('Running `bun run test:coverage`…');
  const run = await $`bun run test:coverage`.cwd(REPO_ROOT).nothrow();
  if (run.exitCode !== 0) {
    console.error(
      `\n\`bun run test:coverage\` exited with code ${run.exitCode} — the coverage gate does not run against a failing or crashed test process.`,
    );
    console.error('Fix the failing/crashing tests first, then re-run `bun run check:coverage`.');
    return false;
  }

  let lcovContent: string;
  try {
    lcovContent = await Bun.file(LCOV_PATH).text();
  } catch {
    console.error(
      `\nExpected an LCOV report at ${LCOV_PATH} but found none — coverage cannot be gated. Was \`test:coverage\` changed to drop \`--coverage-reporter=lcov\`?`,
    );
    return false;
  }

  // In the monorepo, Bun's coverage instrumentation also reports files it
  // reached through the @lostgradient/weft workspace symlink as `../weft/…`
  // records. Those belong to the weft package's own coverage gate, not this
  // one, so keep only package-local files.
  const records = parseLcov(lcovContent).filter(isPackageLocalFile);
  const currentAreas = aggregateByArea(records);
  currentAreas.set('OVERALL', overallTotals(records));

  const gate = resolveBaselineForPlatform(currentAreas);
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
      '\nCoverage dropped below the recorded floor in scripts/coverage-baseline.ts. Add tests to restore it, or — if the drop is an intentional, reviewed tradeoff — raise it in the PR description and update the baseline in the same PR.',
    );
    return false;
  }

  console.log('\nCoverage gate passed — no area dropped below its recorded baseline.');
  return true;
}

if (import.meta.main) {
  const ok = await main();
  process.exit(ok ? 0 : 1);
}
