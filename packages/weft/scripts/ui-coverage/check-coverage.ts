/**
 * Deterministic coverage gate for the UI, the second half of Weft's
 * `test:coverage` (plan §11.7, T0.1 leftovers). `check-coverage-cli.ts` runs
 * one `run-coverage.ts` pass (the UI's `bun test --coverage` invocation, with
 * the same `--config=./bunfig.ui.toml --conditions browser --conditions
 * svelte` flags the UI half of `test` uses), parses the LCOV report it writes
 * to `coverage/ui/lcov.info`, prints per-area line/function coverage, and
 * fails when either the run itself failed or adjusted coverage drops below
 * the floor recorded in `coverage-baseline.ts`.
 *
 * This is a RATCHET, not a 100%-coverage gate. `docs/implementation-plan.md`
 * §11 targets 100% adjusted coverage with an explicit reviewed allowance
 * file, weft-style, once the console's surfaces stabilize — that is the
 * aspirational end state, not what this script enforces today. See
 * `coverage-baseline.ts` for how to move the floor forward.
 *
 * Deliberately NOT a clone of the engine's `scripts/check-coverage.ts`: no
 * per-file line-keyed allowance layers, no refresh-layer partitioning. That
 * machinery was earned over dozens of PRs restoring coverage on a mature
 * codebase; a bootstrapping console gates on area-level totals instead.
 *
 * **The UI layout.** The floors in `coverage-baseline.ts` and the test orders
 * in `coverage-test-order*.ts` were recorded while the UI was a workspace of
 * its own, so they name files by that workspace's layout: `src/…` for its
 * source, `tests/…` and `fixtures/…` beside it, `scripts/browser/…` for the
 * browser tooling, and `scripts/…` for these coverage scripts. The UI now
 * lives inside Weft, at `src/ui/…`, `src/ui/tests/…`, `src/ui/fixtures/…`,
 * `scripts/ui-browser/…`, and `scripts/ui-coverage/…`. {@link uiLayoutPath}
 * translates a Weft path into that layout, so every area keeps the name, and
 * every recorded floor and order keeps the meaning, it was recorded with.
 * Anything it does not translate is not UI: the engine files UI tests reach
 * through `@lostgradient/weft` are gated by the engine's own 100% gate.
 *
 * @module
 */
import { join } from 'node:path';

import {
  COVERAGE_BASELINES,
  coverageMeasurementPlatform,
  type AreaCoverage,
  type CoverageBaseline,
} from './coverage-baseline.ts';
import { DARWIN_BASELINE_COVERAGE_TEST_ORDER } from './coverage-test-order-darwin.ts';
import { LINUX_BASELINE_COVERAGE_TEST_ORDER } from './coverage-test-order.ts';

/** Weft's package root, which every path below is relative to. */
const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
/**
 * Where the UI's LCOV report goes, relative to the package root: inside the engine gate's own
 * `coverage/`, which `turbo.json` caches, but in a directory of its own so neither gate reads or
 * removes the other's report.
 */
export const UI_COVERAGE_DIRECTORY = 'coverage/ui';
const COVERAGE_TEST_ROOTS = ['scripts/ui-browser', 'scripts/ui-coverage', 'src/ui'] as const;
/**
 * Test files the coverage run leaves out: the Playwright lane, which `bun test`
 * never runs, and the fixtures' own suite, which the run did not include
 * when the floors were recorded.
 */
const EXCLUDED_COVERAGE_TEST_PREFIXES = ['scripts/ui-browser/tests/e2e/', 'src/ui/fixtures/'];
const BUN_TEST_FILE_PATTERN = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Where a Weft file sits in the UI layout (see the module comment), or
 * `undefined` for a file that is not part of the UI. Longer prefixes come
 * first, so `src/ui/tests/` wins over `src/ui/`.
 */
const UI_LAYOUT_PREFIXES: ReadonlyArray<readonly [weftPrefix: string, uiPrefix: string]> = [
  ['src/ui/tests/', 'tests/'],
  ['src/ui/fixtures/', 'fixtures/'],
  ['src/ui/', 'src/'],
  ['scripts/ui-browser/', 'scripts/browser/'],
  ['scripts/ui-coverage/', 'scripts/'],
];

export function uiLayoutPath(file: string): string | undefined {
  for (const [weftPrefix, uiPrefix] of UI_LAYOUT_PREFIXES) {
    if (file.startsWith(weftPrefix)) return `${uiPrefix}${file.slice(weftPrefix.length)}`;
  }
  return undefined;
}

function baselineCoverageTestRank(platform: NodeJS.Platform): ReadonlyMap<string, number> {
  const order =
    platform === 'darwin'
      ? DARWIN_BASELINE_COVERAGE_TEST_ORDER
      : platform === 'linux'
        ? LINUX_BASELINE_COVERAGE_TEST_ORDER
        : [];
  return new Map<string, number>(order.map((path, index) => [path, index]));
}

function compareCoverageTestFiles(
  left: string,
  right: string,
  rank: ReadonlyMap<string, number>,
): number {
  // The recorded orders are in the UI layout; every selected path translates.
  const leftRank = rank.get(uiLayoutPath(left) ?? left);
  const rightRank = rank.get(uiLayoutPath(right) ?? right);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  if (leftRank !== undefined) return -1;
  if (rightRank !== undefined) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keep the UI's tests in the versioned baseline order, then append new files lexically. */
export function selectCoverageTestFiles(
  paths: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const rank = baselineCoverageTestRank(platform);
  return [...paths]
    .filter(
      (path) =>
        COVERAGE_TEST_ROOTS.some((root) => path.startsWith(`${root}/`)) &&
        !EXCLUDED_COVERAGE_TEST_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
        BUN_TEST_FILE_PATTERN.test(path),
    )
    .toSorted((left, right) => compareCoverageTestFiles(left, right, rank));
}

/** Convert selected files to exact Bun test paths so Bun preserves the supplied order. */
export function coverageTestArguments(
  paths: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return selectCoverageTestFiles(paths, platform).map((path) => `./${path}`);
}

/** Discover every coverage test explicitly so filesystem enumeration cannot reorder the suite. */
export function discoverCoverageTestFiles(
  repositoryRoot = PACKAGE_ROOT,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const testGlob = new Bun.Glob('**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}');
  const candidates = COVERAGE_TEST_ROOTS.flatMap((root) =>
    [...testGlob.scanSync({ cwd: join(repositoryRoot, root), onlyFiles: true })].map(
      (path) => `${root}/${path}`,
    ),
  );
  return selectCoverageTestFiles(candidates, platform);
}

/** One file's coverage counts, straight off an LCOV `end_of_record` block. */
export type FileCoverage = {
  file: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

type MutableRecord = {
  file?: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function freshRecord(): MutableRecord {
  return { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
}

function isCompleteRecord(record: MutableRecord): record is FileCoverage {
  return (
    record.file !== undefined &&
    isFiniteNonNegativeInteger(record.linesFound) &&
    isFiniteNonNegativeInteger(record.linesHit) &&
    isFiniteNonNegativeInteger(record.functionsFound) &&
    isFiniteNonNegativeInteger(record.functionsHit)
  );
}

type NumericField = 'linesFound' | 'linesHit' | 'functionsFound' | 'functionsHit';

// Bun's LCOV writer emits no `FN:`/`FNDA:` per-function detail, only these
// four file-level totals plus `SF:` and `end_of_record` — see parseLcov.
const NUMERIC_FIELD_PREFIXES: ReadonlyArray<readonly [prefix: string, field: NumericField]> = [
  ['FNF:', 'functionsFound'],
  ['FNH:', 'functionsHit'],
  ['LF:', 'linesFound'],
  ['LH:', 'linesHit'],
];

/** Apply a `PREFIX:<number>` line to `record` in place, if it matches a known field. */
function applyNumericField(record: MutableRecord, line: string): void {
  for (const [prefix, field] of NUMERIC_FIELD_PREFIXES) {
    if (line.startsWith(prefix)) {
      record[field] = Number(line.slice(prefix.length));
      return;
    }
  }
}

/**
 * Parse a Bun-generated LCOV report into per-file coverage counts.
 *
 * Best-effort and forgiving of the fields Bun's LCOV writer omits — any line
 * that isn't `SF:`, one of the four {@link NUMERIC_FIELD_PREFIXES}, or
 * `end_of_record` is ignored. A record missing `SF:` or carrying a
 * non-integer count is dropped rather than throwing, since a
 * partial/truncated report should still yield whatever it can for the
 * summary rather than crash the gate on unrelated line noise.
 */
export function parseLcov(content: string): FileCoverage[] {
  const records: FileCoverage[] = [];
  let record = freshRecord();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      record.file = line.slice('SF:'.length);
      continue;
    }
    if (line === 'end_of_record') {
      if (isCompleteRecord(record)) records.push(record);
      record = freshRecord();
      continue;
    }
    applyNumericField(record, line);
  }

  return records;
}

/**
 * Bucket a UI-layout file path (see {@link uiLayoutPath}) into a coverage
 * "area" for the summary table. Generic by directory depth instead of a
 * hardcoded surface list, so
 * a new `src/routes/<domain>` a track adds shows up automatically: direct
 * children of `src/` (`src/app`, `src/lib`, …), one level deeper for
 * `src/routes/<domain>`, and the top-level directory name (`fixtures`,
 * `scripts`, `tests`) for everything outside `src/`.
 */
export function areaForFile(file: string): string {
  const parts = file.split('/');
  const top = parts[0];
  if (top !== 'src') return top === undefined || top === '' ? 'other' : top;
  if (parts.length <= 2) return 'src';
  if (parts[1] === 'routes' && parts.length >= 3) return `src/routes/${parts[2]}`;
  return `src/${parts[1]}`;
}

function emptyTotals(): AreaCoverage {
  return { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
}

function addTotals(totals: AreaCoverage, record: FileCoverage): AreaCoverage {
  return {
    linesFound: totals.linesFound + record.linesFound,
    linesHit: totals.linesHit + record.linesHit,
    functionsFound: totals.functionsFound + record.functionsFound,
    functionsHit: totals.functionsHit + record.functionsHit,
  };
}

/**
 * The UI's records, renamed into the UI layout (see {@link uiLayoutPath}).
 * The run executes from Weft's root, so the engine files UI tests reach
 * through `@lostgradient/weft`, Weft's own test support, the copied Svelte
 * plugin, and other workspaces' source all appear in the same report; those
 * are gated by their own packages, not here, and are dropped.
 */
export function uiCoverageRecords(records: readonly FileCoverage[]): FileCoverage[] {
  const kept: FileCoverage[] = [];
  for (const record of records) {
    const file = uiLayoutPath(record.file);
    if (file !== undefined) kept.push({ ...record, file });
  }
  return kept;
}

/** Sum per-file records into per-area totals (see {@link areaForFile}). */
export function aggregateByArea(records: FileCoverage[]): Map<string, AreaCoverage> {
  const areas = new Map<string, AreaCoverage>();
  for (const record of records) {
    const area = areaForFile(record.file);
    areas.set(area, addTotals(areas.get(area) ?? emptyTotals(), record));
  }
  return areas;
}

/** Sum every file's record into one repo-wide total. */
export function overallTotals(records: FileCoverage[]): AreaCoverage {
  return records.reduce(addTotals, emptyTotals());
}

/** A file with zero found lines/functions is vacuously fully covered. */
export function percentage(hit: number, found: number): number {
  if (found === 0) return 100;
  return (hit / found) * 100;
}

export function formatPercentage(value: number): string {
  return `${value.toFixed(2)}%`;
}

export type Regression = {
  area: string;
  metric: 'lines' | 'functions';
  currentPercentage: number;
  baselinePercentage: number;
};

// Two runs of the exact same command over the exact same source produce
// identical hit/found counts (LCOV counts are exact integers), so this only
// needs to absorb floating-point rounding in the percentage division, not
// day-to-day measurement noise. A real regression is never this small.
const REGRESSION_EPSILON = 1e-9;

/**
 * Compare current per-area totals against the recorded baseline and report
 * every area whose line or function coverage dropped. An area present in the
 * baseline but absent from the current run (e.g. a directory rename) is
 * skipped here — {@link main} warns about it separately instead of gating on
 * a shape change this function can't distinguish from "coverage went to
 * zero."
 */
export function findRegressions(
  current: ReadonlyMap<string, AreaCoverage>,
  baseline: ReadonlyMap<string, AreaCoverage>,
): Regression[] {
  const regressions: Regression[] = [];
  for (const [area, baselineTotals] of baseline) {
    const currentTotals = current.get(area);
    if (currentTotals === undefined) continue;

    const currentLines = percentage(currentTotals.linesHit, currentTotals.linesFound);
    const baselineLines = percentage(baselineTotals.linesHit, baselineTotals.linesFound);
    if (currentLines < baselineLines - REGRESSION_EPSILON) {
      regressions.push({
        area,
        metric: 'lines',
        currentPercentage: currentLines,
        baselinePercentage: baselineLines,
      });
    }

    const currentFunctions = percentage(currentTotals.functionsHit, currentTotals.functionsFound);
    const baselineFunctions = percentage(
      baselineTotals.functionsHit,
      baselineTotals.functionsFound,
    );
    if (currentFunctions < baselineFunctions - REGRESSION_EPSILON) {
      regressions.push({
        area,
        metric: 'functions',
        currentPercentage: currentFunctions,
        baselinePercentage: baselineFunctions,
      });
    }
  }
  return regressions;
}

/** Render the per-area (plus `OVERALL`) current-vs-baseline table as printable lines. */
export function renderAreaTable(
  current: ReadonlyMap<string, AreaCoverage>,
  baseline: ReadonlyMap<string, AreaCoverage>,
): string[] {
  const areas = [...new Set([...current.keys(), ...baseline.keys()])].toSorted();
  const lines = ['area | lines | functions | baseline lines | baseline functions'];
  for (const area of areas) {
    const totals = current.get(area);
    const base = baseline.get(area);
    const linesCell = totals
      ? formatPercentage(percentage(totals.linesHit, totals.linesFound))
      : '(missing)';
    const functionsCell = totals
      ? formatPercentage(percentage(totals.functionsHit, totals.functionsFound))
      : '(missing)';
    const baseLinesCell = base
      ? formatPercentage(percentage(base.linesHit, base.linesFound))
      : '(new)';
    const baseFunctionsCell = base
      ? formatPercentage(percentage(base.functionsHit, base.functionsFound))
      : '(new)';
    lines.push(
      `${area} | ${linesCell} | ${functionsCell} | ${baseLinesCell} | ${baseFunctionsCell}`,
    );
  }
  return lines;
}

/**
 * Resolve the baseline the current platform gates against. Returns a `null`
 * baseline (after printing why) for the two ungated cases: an unrecognized
 * platform, and a recognized platform with no recorded baseline yet — the
 * latter prints a paste-ready bootstrap object so the first measurement on
 * a new platform (e.g. the first CI run after the darwin/linux split)
 * supplies the numbers a follow-up commit records.
 */
export function resolveBaselineForPlatform(
  currentAreas: ReadonlyMap<string, AreaCoverage>,
  platform: ReturnType<typeof coverageMeasurementPlatform> = coverageMeasurementPlatform(),
  baselines: typeof COVERAGE_BASELINES = COVERAGE_BASELINES,
): {
  baseline: CoverageBaseline | null;
  platform: string;
} {
  if (platform === null) {
    console.log(
      `\nNo coverage baseline vocabulary for platform "${process.platform}" — measurement ran clean but is not gated here. Record a baseline in scripts/ui-coverage/coverage-baseline.ts to gate this platform.`,
    );
    return { baseline: null, platform: process.platform };
  }

  const baseline = baselines[platform];
  if (baseline === null) {
    const bootstrap: CoverageBaseline = {
      measuredAt: new Date().toISOString(),
      overall: currentAreas.get('OVERALL') ?? emptyTotals(),
      areas: Object.fromEntries(
        [...currentAreas.entries()]
          .filter(([area]) => area !== 'OVERALL')
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    };
    console.log(
      `\nNo ${platform} baseline recorded yet — bootstrap mode: measurement ran clean and is NOT gated this run.`,
    );
    console.log(
      `Record it by pasting this into scripts/ui-coverage/coverage-baseline.ts as the ${platform} entry:\n`,
    );
    console.log(JSON.stringify(bootstrap, null, 2));
    return { baseline: null, platform };
  }

  return { baseline, platform };
}
