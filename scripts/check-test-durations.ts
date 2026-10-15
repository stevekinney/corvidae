/**
 * Ratchet on how long a default-gate test may take. On demand it enforces (`bun run
 * check:test-durations`); `bun run validate` runs `--report`, which prints the same findings as
 * warnings and exits 0, because a wall-time budget depends on host load (see `verdict`).
 *
 * Bun applies a 5-second budget to every test. A test that does seconds of real
 * work (spawning processes, bundling, git, instrumented loops) sits near that
 * limit on an idle host, and host contention then multiplies its wall time past
 * it, so whichever such test is on the clock fails `bun run validate` in a
 * package the change never touched (COR-1499).
 *
 * The fast lane of each workspace (`test`, run through
 * `scripts/bun-test-junit.ts`) writes JUnit XML to `test-output/junit/`. This
 * guard reads those reports after `bun run test` and enforces:
 *
 *   - a test that took longer than `BUDGET_MILLISECONDS` fails the check unless
 *     it is listed in `scripts/test-duration-allowlist.json`;
 *   - an allowlisted test that is gone, or that took less than
 *     `STALE_FLOOR_MILLISECONDS`, fails the check as stale, so the allowlist can
 *     only shrink. The floor is half the budget rather than the budget itself:
 *     durations move with host load in both directions, and an entry that sits
 *     at 1.9 s on one run and 2.1 s on the next must not flip the guard;
 *   - a workspace whose `test` script is wrapped must have a report, so a run
 *     that skipped it cannot pass unnoticed;
 *   - a workspace that carries `*.slow.test.ts` files must exclude them from
 *     `test` and define `test:slow`, the serial lane that still runs them in
 *     `bun run validate`. Slow correctness tests live there instead of in the
 *     allowlist.
 *
 * Entries are keyed `<workspace> :: <file> :: <classname> :: <name>` using the
 * report's own `file`, `classname` and `name` attributes. `--shrink` rewrites
 * the allowlist without its stale entries. `--seed` writes the first allowlist
 * from the current reports and refuses to run once one exists, so the list
 * cannot grow by regeneration: adding an entry afterwards is a reviewed edit.
 *
 * Blind spots: only the fast lane is measured; work done at module scope (an
 * `await` outside any test) is not attributed to a test; a report is only as
 * current as the last run, and turbo restores it from cache on a cache hit.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUDGET_MILLISECONDS = 2000;
export const STALE_FLOOR_MILLISECONDS = BUDGET_MILLISECONDS / 2;
export const SLOW_LANE_SUFFIX = '.slow.test.ts';
const WRAPPER_NAMES = ['bun-test-junit.ts', 'run-tests.ts'];
const RUNNER_NAME = 'run-tests.ts';

const root = join(import.meta.dir, '..');
const ALLOWLIST_PATH = join(root, 'scripts', 'test-duration-allowlist.json');
const WORKSPACE_DIRECTORIES = ['applications', 'components', 'packages', 'internal'];
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'build',
  'dist',
  'artifacts',
  'coverage',
  'playwright-report',
  'test-results',
  'test-output',
]);

export interface MeasuredTest {
  key: string;
  milliseconds: number;
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes.set(match[1]!, decodeEntities(match[2]!));
  }
  return attributes;
}

/** Every `<testcase>` of one JUnit report as a keyed duration. A repeated key keeps its slowest run. */
export function parseJunit(workspace: string, xml: string): MeasuredTest[] {
  const slowest = new Map<string, number>();
  for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const attributes = attributesOf(match[0]);
    const seconds = Number(attributes.get('time') ?? '0');
    if (!Number.isFinite(seconds)) continue;
    const key = [
      workspace,
      attributes.get('file') ?? '',
      attributes.get('classname') ?? '',
      attributes.get('name') ?? '',
    ].join(' :: ');
    slowest.set(key, Math.max(slowest.get(key) ?? 0, seconds * 1000));
  }
  return [...slowest].map(([key, milliseconds]) => ({ key, milliseconds }));
}

export interface DurationFindings {
  overBudget: MeasuredTest[];
  stale: { key: string; reason: string }[];
}

/**
 * Judge measured tests against the allowlist. `coveredWorkspaces` limits the stale check to the
 * workspaces whose reports were read, so an entry is never called gone for a report that is absent.
 */
export function judgeDurations(
  measured: readonly MeasuredTest[],
  allowlist: readonly string[],
  coveredWorkspaces: ReadonlySet<string>,
): DurationFindings {
  const allowed = new Set(allowlist);
  const byKey = new Map(measured.map((test) => [test.key, test.milliseconds]));
  const overBudget = measured
    .filter((test) => test.milliseconds > BUDGET_MILLISECONDS && !allowed.has(test.key))
    .toSorted((left, right) => right.milliseconds - left.milliseconds);
  const stale: DurationFindings['stale'] = [];
  for (const key of allowlist) {
    const workspace = key.split(' :: ')[0]!;
    if (!coveredWorkspaces.has(workspace)) continue;
    const milliseconds = byKey.get(key);
    if (milliseconds === undefined) {
      stale.push({ key, reason: 'no such test in the fast lane any more' });
    } else if (milliseconds < STALE_FLOOR_MILLISECONDS) {
      stale.push({
        key,
        reason: `took ${Math.round(milliseconds)} ms, under the ${STALE_FLOOR_MILLISECONDS} ms floor`,
      });
    }
  }
  return { overBudget, stale };
}

function walkWorkspaces(): string[] {
  const workspaces: string[] = [];
  for (const group of WORKSPACE_DIRECTORIES) {
    const groupPath = join(root, group);
    if (!existsSync(groupPath)) continue;
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(groupPath, entry.name, 'package.json'))) {
        workspaces.push(`${group}/${entry.name}`);
      }
    }
  }
  return ['.', ...workspaces];
}

/** Slow-lane files under one workspace. The root workspace excludes the nested workspaces, which own theirs. */
function slowTestFiles(
  directory: string,
  skipped: ReadonlySet<string> = SKIPPED_DIRECTORIES,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      slowTestFiles(join(directory, entry.name), SKIPPED_DIRECTORIES, found);
    } else if (entry.isFile() && entry.name.endsWith(SLOW_LANE_SUFFIX)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

/** The lane-wiring problems of one workspace's manifest. */
export function laneProblems(
  workspace: string,
  scripts: Readonly<Record<string, string>>,
  hasSlowFiles: boolean,
): string[] {
  const problems: string[] = [];
  const test = scripts['test'] ?? '';
  // The root workspace's `test` is a turbo fan-out; its own suites run through `test:self`.
  if (workspace !== '.' && test !== '' && !WRAPPER_NAMES.some((name) => test.includes(name))) {
    problems.push(
      `${workspace}: its test script does not run through scripts/bun-test-junit.ts (or the playground runner), so the duration ratchet cannot see its tests`,
    );
  }
  if (!hasSlowFiles) return problems;
  // `run-tests.ts` is the playground runner, which splits the lanes by file name itself.
  const ignoresSlowFiles = (script: string): boolean =>
    script.includes(RUNNER_NAME) ||
    (script.includes('--path-ignore-patterns') && script.includes(SLOW_LANE_SUFFIX));
  if (!ignoresSlowFiles(test)) {
    problems.push(
      `${workspace}: has ${SLOW_LANE_SUFFIX} files but its test script does not ignore them with --path-ignore-patterns`,
    );
  }
  if (scripts['test:slow'] === undefined) {
    problems.push(`${workspace}: has ${SLOW_LANE_SUFFIX} files but defines no test:slow script`);
  }
  const coverage = scripts['test:coverage'] ?? '';
  if (coverage.includes('bun test') && !ignoresSlowFiles(coverage)) {
    problems.push(
      `${workspace}: test:coverage runs ${SLOW_LANE_SUFFIX} files under Bun's default timeout; ignore them there too with --path-ignore-patterns`,
    );
  }
  return problems;
}

/** The tests of one workspace's fast-lane reports that are over budget and not allowlisted. */
export function budgetFailures(
  workspace: string,
  reportXmls: readonly string[],
  allowlist: readonly string[],
): string[] {
  const measured = reportXmls.flatMap((xml) => parseJunit(workspace, xml));
  return judgeDurations(measured, allowlist, new Set()).overBudget.map(
    (test) => `over budget: ${Math.round(test.milliseconds)} ms — ${test.key}`,
  );
}

interface Collected {
  measured: MeasuredTest[];
  coveredWorkspaces: Set<string>;
  problems: string[];
}

function collect(): Collected {
  const collected: Collected = { measured: [], coveredWorkspaces: new Set(), problems: [] };
  for (const workspace of walkWorkspaces()) {
    const directory = workspace === '.' ? root : join(root, workspace);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};
    const slowFiles = slowTestFiles(
      directory,
      workspace === '.'
        ? new Set([...SKIPPED_DIRECTORIES, ...WORKSPACE_DIRECTORIES])
        : SKIPPED_DIRECTORIES,
    );
    collected.problems.push(...laneProblems(workspace, scripts, slowFiles.length > 0));

    const wrapped = Object.values(scripts).some((script) =>
      WRAPPER_NAMES.some((name) => script.includes(name)),
    );
    const reportDirectory = join(directory, 'test-output', 'junit');
    const reports = existsSync(reportDirectory)
      ? readdirSync(reportDirectory).filter((name) => name.endsWith('.xml'))
      : [];
    if (wrapped && reports.length === 0) {
      collected.problems.push(
        `${workspace}: its test script writes a JUnit report but test-output/junit has none; run bun run test first`,
      );
    }
    for (const report of reports) {
      collected.coveredWorkspaces.add(workspace);
      const xml = readFileSync(join(reportDirectory, report), 'utf8');
      collected.measured.push(...parseJunit(workspace, xml));
    }
  }
  return collected;
}

export function readAllowlist(): string[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { entries: string[] };
  return parsed.entries;
}

function writeAllowlist(entries: readonly string[]): void {
  const document = {
    description:
      'Fast-lane tests allowed to exceed the per-test budget in scripts/check-test-durations.ts. The list can only shrink: --shrink drops stale entries, --seed refuses to run once this file has entries.',
    budgetMilliseconds: BUDGET_MILLISECONDS,
    entries: [...entries].toSorted(),
  };
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

/** Seed headroom: entries at three quarters of the budget absorb the load swing between runs. */
export const SEED_FLOOR_MILLISECONDS = BUDGET_MILLISECONDS * 0.75;

/**
 * Decide the exit code. Over-budget tests and stale entries depend on host load, so `bun run
 * validate` runs the `report` mode, which prints them as warnings and exits 0; the on-demand
 * `enforce` mode (`bun run check:test-durations`) fails on them. Wiring problems (a workspace
 * bypassing the wrapper, slow files without their lane) do not depend on load and fail both.
 */
export function verdict(
  mode: 'report' | 'enforce',
  wiringProblems: readonly string[],
  overBudget: readonly string[],
  stale: readonly string[],
): { exitCode: number; lines: string[] } {
  const loadDependent = [...overBudget, ...stale];
  const lines = [...wiringProblems, ...loadDependent];
  const failing = wiringProblems.length > 0 || (mode === 'enforce' && loadDependent.length > 0);
  return { exitCode: failing ? 1 : 0, lines };
}

function main(): number {
  const mode = Bun.argv[2];
  const collected = collect();
  const allowlist = readAllowlist();

  if (mode === '--seed') {
    if (allowlist.length > 0) {
      process.stderr.write(
        'check-test-durations — the allowlist already has entries; not seeding.\n',
      );
      return 1;
    }
    const seeded = collected.measured
      .filter((test) => test.milliseconds >= SEED_FLOOR_MILLISECONDS)
      .map((test) => test.key);
    writeAllowlist(seeded);
    process.stdout.write(`check-test-durations — seeded ${seeded.length} entries.\n`);
    return 0;
  }

  const findings = judgeDurations(collected.measured, allowlist, collected.coveredWorkspaces);

  if (mode === '--shrink') {
    const staleKeys = new Set(findings.stale.map(({ key }) => key));
    writeAllowlist(allowlist.filter((key) => !staleKeys.has(key)));
    process.stdout.write(`check-test-durations — dropped ${staleKeys.size} stale entries.\n`);
    return 0;
  }

  const overBudget = findings.overBudget.map(
    (test) => `over budget: ${Math.round(test.milliseconds)} ms — ${test.key}`,
  );
  const stale = findings.stale.map(
    (entry) => `stale allowlist entry (${entry.reason}): ${entry.key}`,
  );
  const outcome = verdict(
    mode === '--report' ? 'report' : 'enforce',
    collected.problems,
    overBudget,
    stale,
  );
  if (outcome.lines.length === 0) {
    process.stdout.write(
      `check-test-durations — OK (no fast-lane test over ${BUDGET_MILLISECONDS} ms outside the allowlist of ${allowlist.length}).\n`,
    );
    return 0;
  }
  const heading =
    outcome.exitCode === 0
      ? `check-test-durations — WARNING: the fast lane has tests over ${BUDGET_MILLISECONDS} ms, or the allowlist is stale. Validate does not fail on this; run bun run check:test-durations on a quiet host to enforce it.\n`
      : `check-test-durations — the fast lane has tests over ${BUDGET_MILLISECONDS} ms, or the allowlist is stale.\n`;
  process.stderr.write(
    heading +
      `Make the test fast (drop redundant spawns, bundles, history), or move a test that is slow by\n` +
      `nature to a ${SLOW_LANE_SUFFIX} file run by the workspace's test:slow. Never raise the budget or a timeout.\n` +
      `Remove stale entries with: bun scripts/check-test-durations.ts --shrink\n\n`,
  );
  for (const line of outcome.lines) process.stderr.write(`  ${line}\n`);
  return outcome.exitCode;
}

if (import.meta.main) process.exitCode = main();
