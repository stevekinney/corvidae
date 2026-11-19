// Landing refuses without evidence: the check `direct-merge.ts` and `merge-gate.ts` run, after the
// pinned-run checks of `delivery-verification.ts`, before anything is written to `main`.
//
// The pinned-run checks start from the runs the coordinator named, so a request that names none,
// or none of an aggregated workflow, passes them. This check starts from GitHub instead: the
// workflow runs on the exact head SHA, read with `gh api`. It refuses (a problem string) unless:
//   1. runs exist on the head, and every run it lists is on that SHA;
//   2. every CI evidence identity the request carries resolves to exactly one authenticated run on
//      the head whose plan digest is the one the coordinator pinned (the P07 digest: the batch
//      digest for a manual dispatch, the identity's own for any other event);
//   3. no run of a landing workflow is unfinished or red with a failure `main` does not already
//      have (`ci-compare.ts`'s `compare`), a green `main.yml` or `pull-request.yml` run covers the
//      head, and, when the evidence plan (`evidence-plan.ts`, run in the worktree, which must be at
//      the head) sets `requires_full_run`, the covering run is `main.yml`'s. A `targeted-checks.yml`
//      run is judged for failures but never covers: its dispatch inputs are not readable from the
//      run, so they cannot be compared with the plan;
//   4. an interface path (`applications/interborough/src/{app,routes,views,styles}`,
//      `components/*/src`) has a design verdict with no failing row;
//   5. a one-way door (a plan rule other than `whole-suite:`) goes through a pull request.
//
// The design verdict is a file of the row-verdict format of `.agents/skills/design-review`
// (`row-id | verdict | evidence`, one row per line), recorded beside the execution state as
// `design-verdicts/<head>.verdicts`; a verdict recorded for another head is never read. Every row
// must be `matches` or `deferred`.
//
// Every read fails closed: a `gh` or plan failure, an unreadable answer or a missing dependency is
// a refusal, never a pass.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compare, readFailures, recentMainRuns } from './ci-compare.ts';
import { createGitHubCiEvidenceProvider } from './ci-evidence-github.ts';
import { ciEvidenceRequestKey, type CiEvidenceProvider } from './ci-evidence.ts';
import { batchVerificationPlanDigest } from './delivery-completion.ts';
import type { LoadedDeliveryVerification } from './delivery-verification.ts';
import { defaultRunner, type Runner } from './process-runner.ts';
import { oneWayDoorMatches } from './verification-plan.ts';

export interface LandingDependencies {
  /** Answers `gh` and `bun` commands; the merge's own runner, so one fake serves a test. */
  runner: Runner;
  ciProvider?: Pick<CiEvidenceProvider, 'findRuns'>;
  /** The text of a verdicts file, or `undefined` when there is none. */
  readVerdicts?: (path: string) => string | undefined;
}

export interface LandingRoute {
  route: 'branch' | 'pull-request';
  defaultBranch: string;
}

/** The workflows whose runs on a head count as its evidence. */
export const landingWorkflows: ReadonlySet<string> = new Set([
  '.github/workflows/main.yml',
  '.github/workflows/pull-request.yml',
  '.github/workflows/targeted-checks.yml',
]);

const FULL_WORKFLOW = '.github/workflows/main.yml';
/** The workflows whose green run covers a head: the ones that write an authenticated receipt. */
const COVERING_WORKFLOWS: ReadonlySet<string> = new Set([
  FULL_WORKFLOW,
  '.github/workflows/pull-request.yml',
]);

const INTERFACE_PATH =
  /^(?:applications\/interborough\/src\/(?:app|routes|views|styles)\/|components\/[^/]+\/src\/)/;
const NOT_INTERFACE = /\.(?:test|test-support|spec|playwright|bench)\.[cm]?[jt]sx?$|\.md$/;

/** The interface paths of a change: what needs a design verdict. */
export function interfacePaths(changed: readonly string[]): string[] {
  return changed.filter((path) => INTERFACE_PATH.test(path) && !NOT_INTERFACE.test(path));
}

/** Where a head's design verdicts are recorded, beside the execution state. */
export function designVerdictPath(stateDirectory: string, head: string): string {
  return join(stateDirectory, 'design-verdicts', `${head}.verdicts`);
}

const PASSING_VERDICTS = new Set(['matches', 'deferred']);

/** The rows of a verdicts file that are not a pass, or a problem when it has no rows. */
export function failingVerdictRows(text: string): string[] {
  const rows = text.split('\n').filter((line) => line.trim() !== '');
  if (rows.length === 0) return ['the verdicts file has no rows'];
  return rows.flatMap((line) => {
    const [id = '', verdict = ''] = line.split('|').map((field) => field.trim());
    return id !== '' && PASSING_VERDICTS.has(verdict) ? [] : [`${id || line}: ${verdict || '?'}`];
  });
}

interface ListedRun {
  id: number;
  head: string;
  path: string;
  status: string;
  conclusion: string;
}

function listRuns(runner: Runner, repository: string, head: string): ListedRun[] | string {
  const answer = runner([
    'gh',
    'api',
    `repos/${repository}/actions/runs?head_sha=${head}&per_page=100`,
  ]);
  if (answer.code !== 0)
    return `the workflow runs on ${head} could not be read (gh api exit ${answer.code})`;
  try {
    const parsed = JSON.parse(answer.stdout) as { workflow_runs?: unknown };
    if (!Array.isArray(parsed.workflow_runs)) return 'the workflow runs answer has no run list';
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return parsed.workflow_runs.map((entry: Record<string, unknown>) => ({
      id: Number(entry['id']),
      head: text(entry['head_sha']),
      path: text(entry['path']).split('@')[0] ?? '',
      status: text(entry['status']),
      conclusion: text(entry['conclusion']),
    }));
  } catch {
    return 'the workflow runs answer is not JSON';
  }
}

interface LandingPlan {
  changed: string[];
  requiresFullRun: boolean;
  oneWayDoors: { rule: string; path: string }[];
}

function readPlan(runner: Runner, cwd: string, base: string, head: string): LandingPlan | string {
  // The plan diffs `base...HEAD` of the worktree, so it describes the head only when it is checked out.
  const checkedOut = runner(['git', 'rev-parse', 'HEAD'], { cwd });
  const at = checkedOut.stdout.trim();
  if (checkedOut.code !== 0 || at !== head)
    return `the worktree is at ${at || 'an unreadable revision'}, not the head ${head}, so its evidence plan would describe another change`;
  const answer = runner(['bun', 'scripts/chef/evidence-plan.ts', '--base', base, '--json'], {
    cwd,
  });
  if (answer.code !== 0)
    return `the evidence plan could not be computed (exit ${answer.code}): ${answer.stderr.trim().split('\n')[0] ?? ''}`;
  try {
    const plan = JSON.parse(answer.stdout) as {
      changed?: unknown;
      requires_full_run?: unknown;
      full_run_rules?: unknown;
    };
    if (
      !Array.isArray(plan.changed) ||
      typeof plan.requires_full_run !== 'boolean' ||
      !Array.isArray(plan.full_run_rules)
    )
      return 'the evidence plan answer is missing its changed files or full-run rules';
    const changed = plan.changed.map(String);
    return {
      changed,
      requiresFullRun: plan.requires_full_run,
      // The plan's own one-way-door rules; its whole-suite rules widen the run and are no door.
      oneWayDoors: oneWayDoorMatches(changed),
    };
  } catch {
    return 'the evidence plan answer is not JSON';
  }
}

async function checkDigests(
  verification: LoadedDeliveryVerification,
  listed: readonly ListedRun[],
  source: Pick<CiEvidenceProvider, 'findRuns'>,
): Promise<string | undefined> {
  const { request } = verification;
  const identities = request.ciEvidence;
  if (!Array.isArray(identities) || identities.length === 0)
    return 'the verification request carries no CI evidence identity for the head';
  const batch = batchVerificationPlanDigest(request.members);
  for (const identity of identities) {
    if (identity.requestKey !== ciEvidenceRequestKey(identity))
      return 'a CI evidence identity does not match its request key';
    const expected =
      identity.event === 'workflow_dispatch' ? batch : identity.verificationPlanDigest;
    let observed;
    try {
      observed = await source.findRuns(identity);
    } catch {
      return `CI evidence for ${identity.workflowPath} could not be read`;
    }
    const run = observed[0];
    if (observed.length !== 1 || run === undefined || 'state' in run)
      return `CI evidence for ${identity.workflowPath} is not one finished authenticated run`;
    if (!listed.some((entry) => entry.id === run.id))
      return `run ${run.id} is not among the workflow runs on the head`;
    if (run.checkedRevision !== request.revision || run.head !== request.revision)
      return `run ${run.id} checked ${run.checkedRevision}, not the head ${request.revision}`;
    if (run.verificationPlanDigest !== expected || run.requestKey !== identity.requestKey)
      return `run ${run.id} carries evidence digest ${run.verificationPlanDigest}, not the pinned ${expected}`;
  }
  return undefined;
}

function checkRuns(
  runner: Runner,
  repository: string,
  defaultBranch: string,
  listed: readonly ListedRun[],
  plan: LandingPlan,
): string | undefined {
  const covering: ListedRun[] = [];
  for (const run of listed.filter((entry) => landingWorkflows.has(entry.path))) {
    if (run.status !== 'completed') return `run ${run.id} (${run.path}) has not finished`;
    if (run.conclusion === 'success') {
      covering.push(run);
      continue;
    }
    if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') continue;
    try {
      const id = String(run.id);
      const target = readFailures(runner, repository, id);
      const main = recentMainRuns(runner, repository, defaultBranch, 5, id).map((other) =>
        readFailures(runner, repository, other),
      );
      const comparison = compare(target, main);
      if (comparison.hasNew) {
        const named = comparison.jobs.filter((job) => job.isNew).map((job) => job.name);
        return `run ${run.id} (${run.path}) is red with failures main does not have: ${named.join(', ') || run.conclusion}`;
      }
      covering.push(run);
    } catch (error) {
      return `run ${run.id} is red and could not be compared with main: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const covered = covering.filter((run) => COVERING_WORKFLOWS.has(run.path));
  if (covered.length === 0)
    return 'no finished green main.yml or pull-request.yml run covers the head';
  if (plan.requiresFullRun && !covered.some((run) => run.path === FULL_WORKFLOW))
    return 'the evidence plan requires a full main.yml run, and none is green on the head';
  return undefined;
}

/** Why this head may not land, or `undefined` when its evidence holds. */
export async function validateLandingEvidence(
  verification: LoadedDeliveryVerification,
  route: LandingRoute,
  dependencies: Partial<LandingDependencies> = {},
): Promise<string | undefined> {
  const { request } = verification;
  const runner = dependencies.runner ?? defaultRunner;
  const listed = listRuns(runner, request.repository, request.revision);
  if (typeof listed === 'string') return listed;
  if (listed.length === 0) return `no workflow runs exist on the head ${request.revision}`;
  const elsewhere = listed.find((run) => run.head !== request.revision);
  if (elsewhere !== undefined)
    return `run ${elsewhere.id} is on ${elsewhere.head}, not the head ${request.revision}`;

  const digestProblem = await checkDigests(
    verification,
    listed,
    dependencies.ciProvider ??
      createGitHubCiEvidenceProvider({
        repository: request.repository,
        cwd: request.worktree,
      }),
  );
  if (digestProblem !== undefined) return digestProblem;

  const plan = readPlan(runner, request.worktree, request.base, request.revision);
  if (typeof plan === 'string') return plan;
  const runProblem = checkRuns(runner, request.repository, route.defaultBranch, listed, plan);
  if (runProblem !== undefined) return runProblem;

  const doors = plan.oneWayDoors;
  if (doors.length > 0 && route.route !== 'pull-request')
    return `${doors[0]?.path} is a one-way door (${doors[0]?.rule}) and must go through a pull request, not a branch merge`;

  if (interfacePaths(plan.changed).length > 0) {
    const path = designVerdictPath(verification.state.stateDirectory, request.revision);
    let text: string | undefined;
    try {
      text = (dependencies.readVerdicts ?? ((file) => readFileSync(file, 'utf8')))(path);
    } catch {
      text = undefined;
    }
    if (text === undefined)
      return `${interfacePaths(plan.changed)[0]} is an interface path and ${path} records no design verdict for the head`;
    const failing = failingVerdictRows(text);
    if (failing.length > 0) return `the design verdict has failing rows: ${failing.join('; ')}`;
  }
  return undefined;
}
