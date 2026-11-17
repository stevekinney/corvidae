#!/usr/bin/env bun
// Chef CI comparison: says which failures of a `main.yml` run are new, against `main`'s recent
// runs, so a coordinator accepts a branch on one call instead of reading each failed job by hand
// while `main` is red on and off. For every failed job of the run it lists the failing tests
// (`(fail) <name>` lines of `gh run view --log-failed`), then marks each job and test as seen
// on `main` (with the run IDs) or new. Only a new failure fails the command.
//
// Usage:
//   bun scripts/chef/ci-compare.ts <run id> [--main-runs <n>] [--config <json>] [--json]
//
// `--main-runs` (default 10) is how many completed, conclusive `main.yml` runs on the default
// branch to compare against; the run itself is never one of them. A job with no `(fail)` line
// (a build, lint or duration step) is judged by its job name alone.
//
// Exit codes: 0 every failure was seen on main (or nothing failed), 1 a new failure or the run
// is not complete, 2 invalid CLI usage or GitHub could not be read.

import { MAIN_WORKFLOW } from './main-ci.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { loadRepositoryConfig } from './repository-config.ts';

export { UsageError };

export interface FailedJob {
  name: string;
  tests: string[];
}

export interface RunFailures {
  id: string;
  status: string;
  conclusion: string;
  jobs: FailedJob[];
}

export interface JudgedTest {
  name: string;
  seenIn: string[];
}

export interface JudgedJob {
  name: string;
  seenIn: string[];
  tests: JudgedTest[];
  /** True when the job, or any of its failing tests, never failed in the compared main runs. */
  isNew: boolean;
}

export interface Comparison {
  run: string;
  conclusion: string;
  complete: boolean;
  mainRuns: string[];
  jobs: JudgedJob[];
  hasNew: boolean;
}

function gh(runner: Runner, args: string[]): string {
  const result = runner(['gh', ...args]);
  if (result.code !== 0)
    throw new UsageError(
      `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.code}): ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return result.stdout;
}

/** The failing test names in a `--log-failed` dump, keyed by the job name each line starts with. */
export function failingTests(log: string): Map<string, string[]> {
  const byJob = new Map<string, Set<string>>();
  for (const line of log.split('\n')) {
    const match = /^([^\t]+)\t.*?\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/.exec(line);
    if (match === null) continue;
    const [, job = '', test = ''] = match;
    let tests = byJob.get(job);
    if (tests === undefined) byJob.set(job, (tests = new Set()));
    tests.add(test);
  }
  return new Map([...byJob].map(([job, tests]) => [job, [...tests].toSorted()]));
}

/** A run's failed jobs and their failing tests, read from GitHub. */
export function readFailures(runner: Runner, repository: string, id: string): RunFailures {
  const view = JSON.parse(
    gh(runner, ['run', 'view', id, '--repo', repository, '--json', 'status,conclusion,jobs']),
  ) as { status?: string; conclusion?: string; jobs?: { name?: string; conclusion?: string }[] };
  const failed = (view.jobs ?? [])
    .filter((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out')
    .map((job) => job.name ?? '');
  const tests =
    failed.length === 0
      ? new Map<string, string[]>()
      : failingTests(gh(runner, ['run', 'view', id, '--repo', repository, '--log-failed']));
  return {
    id,
    status: view.status ?? '',
    conclusion: view.conclusion ?? '',
    jobs: failed.map((name) => ({ name, tests: tests.get(name) ?? [] })),
  };
}

/** The IDs of the newest completed, conclusive `main.yml` runs on the default branch. */
export function recentMainRuns(
  runner: Runner,
  repository: string,
  defaultBranch: string,
  count: number,
  exclude: string,
): string[] {
  const listed = JSON.parse(
    gh(runner, [
      'run',
      'list',
      '--repo',
      repository,
      '--workflow',
      MAIN_WORKFLOW,
      '--branch',
      defaultBranch,
      '--status',
      'completed',
      '--limit',
      String(count * 2),
      '--json',
      'databaseId,conclusion',
    ]),
  ) as { databaseId?: number; conclusion?: string }[];
  return listed
    .filter((entry) => entry.conclusion !== 'cancelled' && entry.conclusion !== 'skipped')
    .map((entry) => String(entry.databaseId ?? ''))
    .filter((id) => id !== '' && id !== exclude)
    .slice(0, count);
}

/** Judge each failure of `target` against the failures of `main` runs. */
export function compare(target: RunFailures, main: RunFailures[]): Comparison {
  const jobs = target.jobs.map((job): JudgedJob => {
    const seenIn = main.filter((m) => m.jobs.some((j) => j.name === job.name)).map((m) => m.id);
    const tests = job.tests.map((name): JudgedTest => ({
      name,
      seenIn: main.filter((m) => m.jobs.some((j) => j.tests.includes(name))).map((m) => m.id),
    }));
    const isNew = seenIn.length === 0 || tests.some((test) => test.seenIn.length === 0);
    return { name: job.name, seenIn, tests, isNew };
  });
  const complete = target.status === 'completed';
  return {
    run: target.id,
    conclusion: target.conclusion,
    complete,
    mainRuns: main.map((m) => m.id),
    jobs,
    hasNew: !complete || jobs.some((job) => job.isNew),
  };
}

export function renderComparison(comparison: Comparison): string {
  const lines = [
    `run ${comparison.run}: ${comparison.complete ? comparison.conclusion : 'not complete'}; compared with ${comparison.mainRuns.length} main run(s)`,
  ];
  if (!comparison.complete) lines.push('NOT COMPLETE: wait for the run before judging it.');
  for (const job of comparison.jobs) {
    const where = job.seenIn.length === 0 ? 'NEW' : `seen on main in ${job.seenIn.join(', ')}`;
    lines.push(`${job.isNew ? 'NEW' : 'known'} job ${job.name}: ${where}`);
    for (const test of job.tests)
      lines.push(
        `  ${test.seenIn.length === 0 ? 'NEW' : 'known'} test ${test.name}${test.seenIn.length === 0 ? '' : ` (main ${test.seenIn.join(', ')})`}`,
      );
  }
  if (comparison.jobs.length === 0 && comparison.complete) lines.push('no failed jobs');
  lines.push(comparison.hasNew ? 'verdict: new failures' : 'verdict: no new failures');
  return lines.join('\n');
}

export function run(
  argv: string[],
  runner: Runner = defaultRunner,
): { code: number; output: string } {
  const parsed = parseOptions(argv, { values: ['main-runs', 'config'], flags: ['json'] });
  const [id] = parsed.positionals;
  if (id === undefined || !/^\d+$/.test(id) || parsed.positionals.length > 1)
    throw new UsageError(
      'Usage: ci-compare.ts <run id> [--main-runs <n>] [--config <json>] [--json]',
    );
  const count = Number(parsed.values['main-runs'] ?? '10');
  if (!Number.isInteger(count) || count < 1)
    throw new UsageError('--main-runs needs a positive integer.');
  const config = loadRepositoryConfig(parsed.values['config']);
  const target = readFailures(runner, config.repository, id);
  const mainIds = recentMainRuns(runner, config.repository, config.defaultBranch, count, id);
  const main = mainIds.map((mainId) => readFailures(runner, config.repository, mainId));
  const comparison = compare(target, main);
  return {
    code: comparison.hasNew ? 1 : 0,
    output: parsed.flags.has('json') ? JSON.stringify(comparison) : renderComparison(comparison),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
