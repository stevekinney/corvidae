/**
 * The application's coverage report: this workspace's `test:coverage`. `check-coverage-cli.ts`
 * runs native host tests followed by browser tests in `run-coverage.ts`, with the same
 * `--config=./bunfig.ui.toml --conditions browser --conditions svelte` flags the UI half of `test`
 * uses. It combines native host and browser records, parses the LCOV report it writes to `coverage/ui/lcov.info`, and prints per-area
 * line/function coverage. It is a report: no floor fails it, only a failing test run does.
 *
 * **The layout.** The test orders in `coverage-test-order*.ts` name files by this workspace's
 * layout: `src/…` for the source, `tests/…` and `fixtures/…` beside it, `scripts/browser/…` for
 * the browser tooling, and `scripts/…` for these coverage scripts. The run executes from the
 * application root, so the Weft, Cinder, and other workspace files its tests reach appear in the
 * same report as `../…` paths; {@link uiCoverageRecords} drops them, because each of those
 * workspaces reports its own source.
 *
 * @module
 */
import { isAbsolute, join } from 'node:path';

import { DARWIN_BASELINE_COVERAGE_TEST_ORDER } from './coverage-test-order-darwin.ts';
import { LINUX_BASELINE_COVERAGE_TEST_ORDER } from './coverage-test-order.ts';

/** Raw hit/found counts for one coverage area (or the `OVERALL` rollup). */
export type AreaCoverage = {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

/** The application's package root, which every path below is relative to. */
const PACKAGE_ROOT = join(import.meta.dir, '..');
/**
 * Where the LCOV report goes, relative to the package root: inside `coverage/`, which `turbo.json`
 * caches, in a directory of its own.
 */
export const UI_COVERAGE_DIRECTORY = 'coverage/ui';
const COVERAGE_TEST_ROOTS = ['scripts', 'src', 'tests'] as const;
/**
 * Test files the coverage run leaves out: the Playwright lane, which `bun test` never runs, and
 * the host's suite, which runs under `bunfig.toml` rather than the DOM preload this run uses.
 */
const EXCLUDED_COVERAGE_TEST_PREFIXES = ['tests/e2e/', 'tests/panels/', 'src/host/'];
const BUN_TEST_FILE_PATTERN = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
/**
 * The slow lane's files. `test` ignores `**\/*.slow.test.ts` and `test:slow` runs them under its own
 * budget, so the coverage run, which shares `test`'s 5-second per-test limit, never selects them.
 */
const SLOW_TEST_FILE_PATTERN = /\.slow\.test\.ts$/;

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
  const leftRank = rank.get(left);
  const rightRank = rank.get(right);
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
        BUN_TEST_FILE_PATTERN.test(path) &&
        !SLOW_TEST_FILE_PATTERN.test(path),
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
 * Bucket a file path into a coverage
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
 * The application's own records. The run executes from the application root, so the files of
 * other workspaces that its tests reach (Weft's engine through `@lostgradient/weft`, Cinder, and
 * the rest) appear in the same report as `../…` paths; those are gated by their own packages, not
 * here, and are dropped, with absolute paths and anything under `node_modules`.
 */
export function uiCoverageRecords(records: readonly FileCoverage[]): FileCoverage[] {
  return records.filter(
    (record) =>
      !record.file.startsWith('..') &&
      !isAbsolute(record.file) &&
      !record.file.split('/').includes('node_modules'),
  );
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

/** Render the per-area (plus `OVERALL`) coverage table as printable lines. */
export function renderAreaTable(current: ReadonlyMap<string, AreaCoverage>): string[] {
  const lines = ['area | lines | functions'];
  for (const area of [...current.keys()].toSorted()) {
    const totals = current.get(area);
    if (totals === undefined) continue;
    lines.push(
      `${area} | ${formatPercentage(percentage(totals.linesHit, totals.linesFound))} | ${formatPercentage(percentage(totals.functionsHit, totals.functionsFound))}`,
    );
  }
  return lines;
}

/** Combine native host coverage with browser coverage without counting a source twice. */
export function combineEnvironmentCoverage(browserReport: string, hostReport: string): string {
  const records = (report: string): Map<string, string> => {
    const result = new Map<string, string>();
    for (const block of report.split('end_of_record')) {
      if (block.trim() === '') continue;
      const file = /(?:^|\n)SF:([^\n]+)/.exec(block)?.[1];
      if (file === undefined) throw new Error('Coverage record has no source file.');
      if (result.has(file)) throw new Error(`Duplicate coverage record: ${file}`);
      result.set(file, `${block.trim()}\nend_of_record\n`);
    }
    return result;
  };
  const browser = records(browserReport);
  const host = new Map([...records(hostReport)].filter(([file]) => file.startsWith('src/host/')));
  if (host.size === 0) throw new Error('Native coverage contains no host source files.');
  for (const file of browser.keys()) {
    if (file.startsWith('src/host/') && !host.has(file))
      throw new Error(`Native coverage is missing browser-observed host source: ${file}`);
  }
  for (const [file, record] of host) browser.set(file, record);
  return [...browser.values()].join('\n');
}
