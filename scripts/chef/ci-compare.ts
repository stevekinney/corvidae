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

import { createClient, LinearError, type LinearClient } from './linear.ts';
import { MAIN_WORKFLOW } from './main-ci.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  UsageError,
  type Runner,
} from './process-runner.ts';
import { loadRepositoryConfig } from './repository-config.ts';

export { UsageError };

export interface FailedJob {
  name: string;
  tests: string[];
  /** Independently failed workflow steps, retained even when the job also names a failed test. */
  steps?: string[];
  /** A test error whose file/title/assertion identity could not be safely parsed. */
  unknown?: boolean;
  /** Tagged evidence preserves the failure's role instead of comparing flattened display strings. */
  failures?: FailureRecord[];
}

export interface FailureRecord {
  kind: 'test' | 'step' | 'unknown';
  job: string;
  /** The individual GitHub Actions `Run …` step that produced this evidence. */
  step?: string | undefined;
  command?: string | undefined;
  identity?: string | undefined;
  diagnostic?: string | undefined;
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
  flakes?: FlakeMatch[];
}

/** An existing COR flake issue whose description names the failed test. */
export interface FlakeMatch {
  identifier: string;
  /** A completed issue this flake report identifies as the earlier attempted repair. */
  recursAfter?: string;
}

export interface JudgedJob {
  name: string;
  seenIn: string[];
  tests: JudgedTest[];
  steps: JudgedTest[];
  /** True when the job, or any of its failing tests, never failed in the compared main runs. */
  isNew: boolean;
  /** A test job whose log named no failing test: judge it by reading the log, never as known. */
  unknown: boolean;
}

export interface Comparison {
  run: string;
  conclusion: string;
  complete: boolean;
  /** Completed without success yet with no failed job: nothing ran that could be judged. */
  noEvidence: boolean;
  mainRuns: string[];
  jobs: JudgedJob[];
  hasNew: boolean;
  /** Linear is advisory evidence: an unread lookup never turns a known CI failure into a new one. */
  flakeLookupProblem?: string;
}

function gh(runner: Runner, args: string[]): string {
  const result = runner(['gh', ...args]);
  if (result.code !== 0)
    throw new UsageError(
      `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.code}): ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return result.stdout;
}

/** A Bun `(fail) <name> [12ms]` line. */
const BUN_FAILURE = /^([^\t]+)\t.*?\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/;
/** A Bun file group before its test names. */
const BUN_TEST_FILE = /^([^\t]+)\t.*?##\[group\](.+?\.test\.ts):\s*$/;
/** Bun's assertion header when a failed test is printed without a `(fail)` summary line. */
const BUN_ASSERTION = /^([^\t]+)\t.*?error: (expect\(.+\))\s*$/;
/** The assertion's specific expected value, which makes its file-qualified identity stable. */
const BUN_EXPECTED = /^([^\t]+)\t.*?Expected to contain: (.+)\s*$/;
const BUN_ERROR = /^([^\t]+)\t.*?error: /;
const BUN_SCRIPT_EXIT = /^script ".+" exited with code \d+$/;
/** Turbo's per-workspace task heading in a failed GitHub Actions log. */
const TURBO_TASK = /^([^\t]+)\t.*?##\[group\](@lostgradient\/[^\s:]+):[^\s]+\s*$/;
/** A GitHub Actions step boundary. */
const RUN_STEP = /^([^\t]+)\t.*?##\[group\]Run (.+)\s*$/;
/** GitHub's final nonzero marker for a failed workflow step. */
const STEP_FAILURE = /^([^\t]+)\t.*?##\[error\]Process completed with exit code \d+\./;
/** A Playwright failure heading, `  1) [chromium] › tests/e2e/x.spec.ts:69:3 › title`. */
const PLAYWRIGHT_FAILURE = /^([^\t]+)\t.*?\s\d+\) \[[\w-]+\] › (.+?)\s*$/;

interface TestEvidence {
  job: string;
  /** A run-local provenance key; it never participates in cross-run identity matching. */
  step?: string | undefined;
  command?: string | undefined;
  identity?: string | undefined;
  unparseable?: boolean | undefined;
}

interface TestContext {
  step: string;
  command: string;
  task?: string | undefined;
  file?: string | undefined;
  assertion?: string | undefined;
  unparseable?: boolean | undefined;
}

/**
 * Extract test evidence once, scoped to an individual GitHub Actions Run occurrence. A test
 * identity is deliberately separate from the occurrence that produced it: topology may change
 * between runs, while a later Run step may never inherit a previous step's file or task context.
 */
function testEvidence(log: string): TestEvidence[] {
  const contexts = new Map<string, TestContext>();
  const unscopedFiles = new Set<string>();
  const counts = new Map<string, number>();
  const found: TestEvidence[] = [];
  const markUnknown = (job: string, context: TestContext | undefined) => {
    if (context?.unparseable === true) return;
    if (context !== undefined) context.unparseable = true;
    found.push({
      job,
      ...(context === undefined ? {} : { step: context.step, command: context.command }),
      unparseable: true,
    });
  };
  const finish = (job: string) => {
    const context = contexts.get(job);
    if (context?.assertion !== undefined) markUnknown(job, context);
  };
  const identity = (context: TestContext, value: string) =>
    `${context.task === undefined ? '' : `${context.task} › `}${context.file} › ${value}`;

  for (const line of log.split('\n')) {
    const step = RUN_STEP.exec(line);
    if (step !== null) {
      const job = step[1] ?? '';
      finish(job);
      const command = step[2] ?? '';
      const index = (counts.get(job) ?? 0) + 1;
      counts.set(job, index);
      contexts.set(job, { command, step: `${command}#${index}` });
      unscopedFiles.delete(job);
      continue;
    }
    const task = TURBO_TASK.exec(line);
    if (task !== null) {
      const context = contexts.get(task[1] ?? '');
      if (context !== undefined) context.task = task[2] ?? '';
      continue;
    }
    const file = BUN_TEST_FILE.exec(line);
    if (file !== null) {
      const context = contexts.get(file[1] ?? '');
      if (context !== undefined) {
        context.file = file[2] ?? '';
        context.assertion = undefined;
      } else unscopedFiles.add(file[1] ?? '');
      continue;
    }
    const assertion = BUN_ASSERTION.exec(line);
    if (assertion !== null) {
      const context = contexts.get(assertion[1] ?? '');
      if (context?.file !== undefined) context.assertion = assertion[2] ?? '';
      else markUnknown(assertion[1] ?? '', context);
      continue;
    }
    const expected = BUN_EXPECTED.exec(line);
    if (expected !== null) {
      const job = expected[1] ?? '';
      const context = contexts.get(job);
      if (context?.file !== undefined && context.assertion !== undefined) {
        found.push({
          job,
          step: context.step,
          command: context.command,
          identity: identity(context, `${context.assertion} › ${expected[2] ?? ''}`),
        });
        context.assertion = undefined;
      } else markUnknown(job, context);
      continue;
    }
    const bun = BUN_FAILURE.exec(line);
    if (bun !== null) {
      const job = bun[1] ?? '';
      const context = contexts.get(job);
      if (context?.file !== undefined)
        found.push({
          job,
          step: context.step,
          command: context.command,
          identity: identity(context, bun[2] ?? ''),
        });
      else markUnknown(job, context);
      continue;
    }
    const playwright = PLAYWRIGHT_FAILURE.exec(line);
    if (playwright !== null) {
      const job = playwright[1] ?? '';
      const context = contexts.get(job);
      if (context !== undefined)
        found.push({
          job,
          step: context.step,
          command: context.command,
          identity: playwright[2] ?? '',
        });
      else markUnknown(job, context);
      continue;
    }
    const error = BUN_ERROR.exec(line);
    if (error !== null) {
      const job = error[1] ?? '';
      const context = contexts.get(job);
      const diagnostic = line.split('error: ').at(-1)?.trim();
      if (
        (context?.file !== undefined || unscopedFiles.has(job)) &&
        (diagnostic === undefined || !BUN_SCRIPT_EXIT.test(diagnostic))
      )
        markUnknown(job, context);
    }
  }
  for (const job of contexts.keys()) finish(job);
  return found;
}

/** The failing test names in a `--log-failed` dump, keyed by the job name each line starts with. */
export function failingTests(log: string): Map<string, string[]> {
  const byJob = new Map<string, Set<string>>();
  for (const evidence of testEvidence(log)) {
    if (evidence.identity === undefined) continue;
    const tests = byJob.get(evidence.job) ?? new Set<string>();
    tests.add(evidence.identity);
    byJob.set(evidence.job, tests);
  }
  return new Map([...byJob].map(([job, tests]) => [job, [...tests].toSorted()]));
}

/** Non-test failures retain their GitHub step identity even when their job also reports tests. */
export function failingSteps(log: string): Map<string, string[]> {
  const byJob = new Map<string, Set<string>>();
  const stepByJob = new Map<string, string>();
  for (const line of log.split('\n')) {
    const step = RUN_STEP.exec(line);
    if (step !== null) {
      stepByJob.set(step[1] ?? '', step[2] ?? '');
      continue;
    }
    const failed = STEP_FAILURE.exec(line);
    if (failed === null) continue;
    const job = failed[1] ?? '';
    const current = stepByJob.get(job);
    if (current === undefined) continue;
    let steps = byJob.get(job);
    if (steps === undefined) byJob.set(job, (steps = new Set()));
    steps.add(current);
  }
  return new Map([...byJob].map(([job, steps]) => [job, [...steps].toSorted()]));
}

function stepFailures(log: string): FailureRecord[] {
  const steps = new Map<
    string,
    { command: string; step: string; diagnostic?: string | undefined }
  >();
  const counts = new Map<string, number>();
  const found: FailureRecord[] = [];
  for (const line of log.split('\n')) {
    const step = RUN_STEP.exec(line);
    if (step !== null) {
      const job = step[1] ?? '';
      const command = step[2] ?? '';
      const index = (counts.get(job) ?? 0) + 1;
      counts.set(job, index);
      steps.set(job, { command, step: `${command}#${index}` });
      continue;
    }
    const error = BUN_ERROR.exec(line);
    if (error !== null && steps.has(error[1] ?? '')) {
      const diagnostic = line.split('error: ').at(-1)?.trim();
      if (diagnostic !== undefined && !BUN_SCRIPT_EXIT.test(diagnostic))
        steps.get(error[1] ?? '')!.diagnostic = diagnostic;
      continue;
    }
    const failed = STEP_FAILURE.exec(line);
    if (failed === null) continue;
    const job = failed[1] ?? '';
    const current = steps.get(job);
    if (current !== undefined) found.push({ kind: 'step', job, ...current });
  }
  return found;
}

function isTestLauncher(command: string): boolean {
  return /\b(?:bun(?:x)?\s+(?:--bun\s+)?(?:test|playwright)\b|bun(?:x)?\s+run\s+test(?=:|\s|$)|bunx\s+turbo\s+run\s+test(?=:|\s|$)|run-gated-browser-suite)\b/.test(
    command,
  );
}

/** Parse all failure roles; unqualified launchers and diagnostics remain explicit unknown evidence. */
export function failureRecords(log: string): Map<string, FailureRecord[]> {
  const evidence = testEvidence(log);
  const qualified = new Set(
    evidence.flatMap((item) =>
      item.identity === undefined || item.step === undefined ? [] : [item.step],
    ),
  );
  const records = new Map<string, FailureRecord[]>();
  const add = (job: string, record: FailureRecord) => {
    const values = records.get(job) ?? [];
    values.push(record);
    records.set(job, values);
  };
  for (const item of evidence) {
    if (item.identity !== undefined)
      add(item.job, {
        kind: 'test',
        job: item.job,
        step: item.step,
        command: item.command,
        identity: item.identity,
      });
    else if (item.unparseable === true)
      add(item.job, {
        kind: 'unknown',
        job: item.job,
        step: item.step,
        command: item.command,
        diagnostic: 'unparseable test error',
      });
  }
  for (const step of stepFailures(log)) {
    if (isTestLauncher(step.command ?? '')) {
      if (!qualified.has(step.step ?? ''))
        add(step.job, { kind: 'unknown', job: step.job, step: step.step, command: step.command });
      continue;
    }
    if (step.diagnostic === undefined)
      add(step.job, { kind: 'unknown', job: step.job, command: step.command });
    else add(step.job, step);
  }
  return records;
}

/** Test-file errors without a complete identity stay unknown instead of inheriting a known step. */
export function unparseableTestJobs(log: string): Set<string> {
  return new Set(
    testEvidence(log)
      .filter((item) => item.unparseable === true)
      .map((item) => item.job),
  );
}

/** A run's failed jobs and their failing tests, read from GitHub. */
export function readFailures(runner: Runner, repository: string, id: string): RunFailures {
  const view = JSON.parse(
    gh(runner, ['run', 'view', id, '--repo', repository, '--json', 'status,conclusion,jobs']),
  ) as { status?: string; conclusion?: string; jobs?: { name?: string; conclusion?: string }[] };
  const failed = (view.jobs ?? [])
    .filter((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out')
    .map((job) => job.name ?? '');
  // GitHub serves `--log-failed` only for a finished run; an unfinished one is judged NOT COMPLETE.
  const log =
    failed.length === 0 || view.status !== 'completed'
      ? ''
      : gh(runner, ['run', 'view', id, '--repo', repository, '--log-failed']);
  const tests = failingTests(log);
  const steps = failingSteps(log);
  const unknown = unparseableTestJobs(log);
  const records = failureRecords(log);
  return {
    id,
    status: view.status ?? '',
    conclusion: view.conclusion ?? '',
    jobs: failed.map((name) => ({
      name,
      tests: tests.get(name) ?? [],
      steps: steps.get(name) ?? [],
      unknown: unknown.has(name),
      failures: records.get(name) ?? [],
    })),
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
      // A newer push replaces each pending run, so most completed runs are cancelled: read deep.
      '--limit',
      String(Math.max(count * 10, 100)),
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

/** A job that runs tests, so its failures should name them. */
const TEST_JOB = /(^|\s)tests\b|end-to-end|e2e|fixtures|integration/i;

/** Only a file-qualified failure can be matched across changed jobs or workflow topology. */
function isStableTestIdentity(name: string): boolean {
  return (
    /(?:^|\s)[^\s]+\.test\.ts › /.test(name) || /(?:^|\s)[^\s]+\.spec\.ts:\d+:\d+ › /.test(name)
  );
}

function recordsFor(job: FailedJob): FailureRecord[] {
  if (job.failures !== undefined) return job.failures;
  return [
    ...job.tests.map((identity) => ({ kind: 'test' as const, job: job.name, identity })),
    ...(job.steps ?? []).map((command) => ({ kind: 'step' as const, job: job.name, command })),
    ...(job.unknown === true ? [{ kind: 'unknown' as const, job: job.name }] : []),
  ];
}

function sameFailure(left: FailureRecord, right: FailureRecord): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'unknown') return false;
  if (left.kind === 'test')
    return (
      left.identity === right.identity &&
      (left.job === right.job || isStableTestIdentity(left.identity ?? ''))
    );
  return (
    left.job === right.job &&
    left.command === right.command &&
    left.diagnostic !== undefined &&
    left.diagnostic === right.diagnostic
  );
}

/** Judge each failure of `target` against the failures of `main` runs. */
export function compare(target: RunFailures, main: RunFailures[]): Comparison {
  const jobs = target.jobs.map((job): JudgedJob => {
    const records = recordsFor(job);
    const judgeFailure = (record: FailureRecord): JudgedTest => ({
      name:
        record.kind === 'test'
          ? (record.identity ?? '<unknown test>')
          : record.kind === 'step'
            ? `${record.command ?? '<unknown step>'}: ${record.diagnostic ?? '<unknown diagnostic>'}`
            : (record.diagnostic ?? '<unknown failure>'),
      seenIn: main
        .filter((m) =>
          m.jobs.some((other) => recordsFor(other).some((item) => sameFailure(record, item))),
        )
        .map((m) => m.id),
    });
    const tests = records.filter((record) => record.kind === 'test').map(judgeFailure);
    const steps = records.filter((record) => record.kind === 'step').map(judgeFailure);
    const unknown =
      records.some((record) => record.kind === 'unknown') ||
      (records.length === 0 && TEST_JOB.test(job.name));
    const seenIn =
      records.length === 0
        ? main.filter((m) => m.jobs.some((other) => other.name === job.name)).map((m) => m.id)
        : [...new Set([...tests, ...steps].flatMap((failure) => failure.seenIn))];
    const isNew =
      unknown ||
      (records.length === 0
        ? seenIn.length === 0
        : [...tests, ...steps].some((failure) => failure.seenIn.length === 0));
    return { name: job.name, seenIn, tests, steps, isNew, unknown };
  });
  const complete = target.status === 'completed';
  // A run that did not succeed yet names no failed job (a startup failure, a cancellation) gives no
  // evidence either way, so it never passes.
  const noEvidence = complete && target.conclusion !== 'success' && jobs.length === 0;
  return {
    run: target.id,
    conclusion: target.conclusion,
    complete,
    noEvidence,
    mainRuns: main.map((m) => m.id),
    jobs,
    hasNew: !complete || noEvidence || jobs.some((job) => job.isNew),
  };
}

export function renderComparison(comparison: Comparison): string {
  const lines = [
    `run ${comparison.run}: ${comparison.complete ? comparison.conclusion : 'not complete'}; compared with ${comparison.mainRuns.length} main run(s)`,
  ];
  if (!comparison.complete) lines.push('NOT COMPLETE: wait for the run before judging it.');
  if (comparison.noEvidence)
    lines.push(`NO EVIDENCE: the run ended ${comparison.conclusion} with no failed job; rerun it.`);
  for (const job of comparison.jobs) {
    const where = job.seenIn.length === 0 ? 'NEW' : `seen on main in ${job.seenIn.join(', ')}`;
    lines.push(
      job.unknown
        ? `UNKNOWN job ${job.name}: its log names no failing test; read it (${where})`
        : `${job.isNew ? 'NEW' : 'known'} job ${job.name}: ${where}`,
    );
    for (const test of job.tests)
      lines.push(
        `  ${test.seenIn.length === 0 ? 'NEW' : 'known'} test ${test.name}${test.seenIn.length === 0 ? '' : ` (main ${test.seenIn.join(', ')})`}${test.flakes === undefined ? '' : test.flakes.map((flake) => ` (${flake.identifier}${flake.recursAfter === undefined ? '' : ` recurs after ${flake.recursAfter} Done`})`).join('')}`,
      );
    for (const step of job.steps)
      lines.push(
        `  ${step.seenIn.length === 0 ? 'NEW' : 'known'} step ${step.name}${step.seenIn.length === 0 ? '' : ` (main ${step.seenIn.join(', ')})`}`,
      );
  }
  if (comparison.flakeLookupProblem !== undefined)
    lines.push(`FLAKE LOOKUP UNAVAILABLE: ${comparison.flakeLookupProblem}`);
  if (comparison.jobs.length === 0 && comparison.complete) lines.push('no failed jobs');
  lines.push(comparison.hasNew ? 'verdict: new failures' : 'verdict: no new failures');
  return lines.join('\n');
}

interface LinearIssue {
  identifier: string;
  description: string | null;
  state: { name: string; type: string };
}

const normalizeMatchText = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The test title is the stable part after the owning file or Playwright location. */
function testTitle(name: string): string | undefined {
  const title = name.split(' › ').at(-1)?.trim();
  return title === undefined || title === '' || title.startsWith('expect(') ? undefined : title;
}

async function referencedCompletedFixes(
  client: LinearClient,
  description: string,
): Promise<string[]> {
  const identifiers = [...new Set(description.match(/\bCOR-\d+\b/g) ?? [])];
  const completed: string[] = [];
  for (const identifier of identifiers) {
    const data = await client.request<{ issue: Pick<LinearIssue, 'identifier' | 'state'> | null }>(
      `query FlakeFix($id: String!) { issue(id: $id) { identifier state { name type } } }`,
      { id: identifier },
    );
    if (data.issue?.state.type === 'completed') completed.push(identifier);
  }
  return completed;
}

/**
 * Adds existing COR flake reports to named CI failures. Matching requires the test title in an
 * issue description; a similar issue title alone is deliberately not evidence of the same flake.
 */
export async function matchFlakeIssues(
  comparison: Comparison,
  client: LinearClient,
): Promise<Comparison> {
  const tests = comparison.jobs.flatMap((job) => job.tests);
  try {
    for (const test of tests) {
      const title = testTitle(test.name);
      if (title === undefined) continue;
      const data = await client.request<{ issues: { nodes: LinearIssue[] } }>(
        `query FlakeIssues($filter: IssueFilter) { issues(first: 100, filter: $filter) { nodes { identifier description state { name type } } } }`,
        {
          filter: {
            team: { key: { eq: 'COR' } },
            description: { containsIgnoreCase: title },
          },
        },
      );
      const titleText = normalizeMatchText(title);
      const matches = data.issues.nodes.filter((issue) =>
        normalizeMatchText(issue.description ?? '').includes(titleText),
      );
      if (matches.length === 0) continue;
      const flakeMatches = await Promise.all(
        matches.map(async (issue) => {
          const completed = await referencedCompletedFixes(client, issue.description ?? '');
          return {
            identifier: issue.identifier,
            ...(completed[0] === undefined ? {} : { recursAfter: completed[0] }),
          };
        }),
      );
      test.flakes = flakeMatches.toSorted((left, right) =>
        left.identifier.localeCompare(right.identifier),
      );
    }
  } catch (error) {
    comparison.flakeLookupProblem =
      error instanceof LinearError || error instanceof Error ? error.message : String(error);
  }
  return comparison;
}

function judge(
  argv: string[],
  runner: Runner = defaultRunner,
): { comparison: Comparison; json: boolean } {
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
  return { comparison, json: parsed.flags.has('json') };
}

/** CI comparison without tracker evidence, kept synchronous for local callers and unit tests. */
export function run(
  argv: string[],
  runner: Runner = defaultRunner,
): { code: number; output: string } {
  const { comparison, json } = judge(argv, runner);
  return {
    code: comparison.hasNew ? 1 : 0,
    output: json ? JSON.stringify(comparison) : renderComparison(comparison),
  };
}

/** The coordinator-facing command: enrich comparison output with read-only COR flake evidence. */
export async function runWithFlakeIssues(
  argv: string[],
  runner: Runner = defaultRunner,
  client: LinearClient = createClient(),
): Promise<{ code: number; output: string }> {
  const { comparison, json } = judge(argv, runner);
  await matchFlakeIssues(comparison, client);
  return {
    code: comparison.hasNew ? 1 : 0,
    output: json ? JSON.stringify(comparison) : renderComparison(comparison),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await runWithFlakeIssues(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
