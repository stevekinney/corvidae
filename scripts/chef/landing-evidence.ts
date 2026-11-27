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
//   3. no run of a landing workflow is unfinished, or red with a failure `main` does not already
//      have (`ci-compare.ts`'s `compare`), and a green run covers the head. A red run never
//      covers, even when `main` has its failures. Green means conclusion `success` with no job
//      failed, cancelled or timed out. Coverage is a `main.yml` or `pull-request.yml` run when an
//      evidence identity binds it, or a `targeted-checks.yml` run whose run name carries the plan
//      digest this check computes (`landing-plan.ts`); a plan that needs the full run (a one-way
//      door or a whole-suite change) is covered only by a bound `main.yml` run;
//   4. an interface path (`applications/interborough/src/{app,routes,views,styles}`,
//      `components/*/src`) has a design verdict with no failing row (`design-verdict.ts`);
//   5. a one-way door goes through a pull request.
//
// The plan is computed here, from `git diff --name-only <base>...<head>` with every status and the
// rules this code carries. Nothing from the worker's checkout is executed: a head cannot rewrite
// the gate that judges it.
//
// Every read fails closed: a `gh` or git failure, an unreadable answer or a missing dependency is a
// refusal, never a pass.

import { readFileSync } from 'node:fs';

import { compare, readFailures, recentMainRuns } from './ci-compare.ts';
import { createGitHubCiEvidenceProvider } from './ci-evidence-github.ts';
import { ciEvidenceRequestKey, type CiEvidenceProvider } from './ci-evidence.ts';
import { batchVerificationPlanDigest } from './delivery-completion.ts';
import type { LoadedDeliveryVerification } from './delivery-verification.ts';
import { designDigest, exclusionResult } from './design-exclusions.ts';
import { designVerdictPath, failingVerdictRows } from './design-verdict.ts';
import { changedPaths, landingPlan, type LandingPlan } from './landing-plan.ts';
import { defaultRunner, type Runner } from './process-runner.ts';

export interface LandingDependencies {
  /** Answers `gh` and `git` commands; the merge's own runner, so one fake serves a test. */
  runner: Runner;
  ciProvider?: Pick<CiEvidenceProvider, 'findRuns'>;
  /** The text of a verdicts file, or `undefined` when there is none. */
  readVerdicts?: (path: string) => string | undefined;
}

export interface LandingRoute {
  route: 'branch' | 'pull-request';
  defaultBranch: string;
  /** The tree the caller just derived for the candidate against its current base. */
  integrationTree?: string;
  /** The actual incoming base, which can differ from the verification request's base. */
  incomingBase?: string;
}

const FULL_WORKFLOW = '.github/workflows/main.yml';
const PULL_REQUEST_WORKFLOW = '.github/workflows/pull-request.yml';
const TARGETED_WORKFLOW = '.github/workflows/targeted-checks.yml';
const FULL_RECEIPT_JOBS = [
  'root',
  'workspaces',
  'tests',
  'tests-slow',
  'browser',
  'test-durations',
] as const;

/** The workflows whose runs on a head are judged. */
export const landingWorkflows: ReadonlySet<string> = new Set([
  FULL_WORKFLOW,
  PULL_REQUEST_WORKFLOW,
  TARGETED_WORKFLOW,
]);

const INTERFACE_PATH =
  /^(?:applications\/interborough\/src\/(?:app|routes|views|styles)\/|components\/[^/]+\/src\/)/;
const NOT_INTERFACE = /\.(?:test|test-support|spec|playwright|bench)\.[cm]?[jt]sx?$|\.md$/;

/** The interface paths of a change: what needs a design verdict. */
export function interfacePaths(changed: readonly string[]): string[] {
  return changed.filter((path) => INTERFACE_PATH.test(path) && !NOT_INTERFACE.test(path));
}

/** The run name `targeted-checks.yml` takes from its `plan_digest` input. */
export const targetedRunName = (digest: string): string => `targeted ${digest}`;

interface ListedRun {
  id: number;
  head: string;
  path: string;
  title: string;
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
      title: text(entry['display_title']),
      status: text(entry['status']),
      conclusion: text(entry['conclusion']),
    }));
  } catch {
    return 'the workflow runs answer is not JSON';
  }
}

const BAD_JOB = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
]);

/** A problem when a run's jobs cannot be read or one of them did not go green. */
function jobsProblem(
  runner: Runner,
  repository: string,
  run: ListedRun,
  allowEmpty = false,
): string | undefined {
  const answer = runner([
    'gh',
    'api',
    `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
  ]);
  if (answer.code !== 0) return `the jobs of run ${run.id} could not be read`;
  try {
    const jobs = (JSON.parse(answer.stdout) as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) return `run ${run.id} has an invalid job list`;
    if (!allowEmpty && jobs.length === 0) return `run ${run.id} lists no jobs`;
    const bad = (jobs as { name?: unknown; conclusion?: unknown }[]).find((job) =>
      BAD_JOB.has(String(job.conclusion)),
    );
    return bad === undefined
      ? undefined
      : `job ${String(bad.name)} of run ${run.id} concluded ${String(bad.conclusion)}`;
  } catch {
    return `the jobs of run ${run.id} are not JSON`;
  }
}

interface BoundRuns {
  ids: ReadonlySet<number>;
  reusableFullIds: ReadonlySet<number>;
}

function hasCompleteFullReceipt(
  receiptJobs: Record<string, 'success' | 'not-applicable'>,
): boolean {
  return FULL_RECEIPT_JOBS.every((name) => receiptJobs[name] === 'success');
}

function allowsPullRequestDuplicateReuse(changed: readonly string[]): boolean {
  return !changed.some(
    (path) =>
      path.startsWith('.github/') ||
      path === 'package.json' ||
      path === 'turbo.json' ||
      /^scripts\/affected-tests(?:[-.].*)?\.ts$/.test(path),
  );
}

async function checkDigests(
  verification: LoadedDeliveryVerification,
  listed: readonly ListedRun[],
  source: Pick<CiEvidenceProvider, 'findRuns'>,
): Promise<BoundRuns | string> {
  const { request } = verification;
  const batch = batchVerificationPlanDigest(request.members);
  const ids = new Set<number>();
  const reusableFullIds = new Set<number>();
  for (const identity of request.ciEvidence ?? []) {
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
    const listedRun = listed.find((entry) => entry.id === run.id);
    if (listedRun === undefined) return `run ${run.id} is not among the workflow runs on the head`;
    if (listedRun.path !== identity.workflowPath)
      return `run ${run.id} is listed as ${listedRun.path}, not ${identity.workflowPath}`;
    // For a PR, the provider authenticates both parents of GitHub's synthetic merge checkout.
    if (
      run.head !== request.revision ||
      (identity.event !== 'pull_request' && run.checkedRevision !== request.revision)
    )
      return `run ${run.id} checked ${run.checkedRevision}, not the head ${request.revision}`;
    if (
      run.checkedTree !== request.integrationTree ||
      run.integrationTree !== request.integrationTree
    )
      return `run ${run.id} checked tree ${run.checkedTree} and reported integration tree ${run.integrationTree}; expected ${request.integrationTree}`;
    if (identity.event === 'pull_request') {
      if (run.event !== 'pull_request' || run.base !== request.base)
        return `run ${run.id} did not check the proposed pull-request merge`;
      const pinned = request.members.flatMap((member) =>
        member.providerRuns.filter((binding) => binding.event === 'pull_request'),
      );
      if (
        pinned.length === 0 ||
        pinned.some((binding) => binding.id !== run.id || binding.attempt !== run.attempt)
      )
        return `run ${run.id} does not match the pinned pull-request attempt`;
    }
    if (run.verificationPlanDigest !== expected || run.requestKey !== identity.requestKey)
      return `run ${run.id} carries evidence digest ${run.verificationPlanDigest}, not the pinned ${expected}`;
    const fullReceipt =
      identity.workflowPath === FULL_WORKFLOW && hasCompleteFullReceipt(run.receiptJobs);
    if (identity.workflowPath === FULL_WORKFLOW && !fullReceipt)
      return `pinned main.yml evidence run ${run.id} does not have a complete full receipt`;
    ids.add(run.id);
    if (
      identity.event === 'workflow_dispatch' &&
      identity.workflowPath === FULL_WORKFLOW &&
      listedRun.status === 'completed' &&
      listedRun.conclusion === 'success' &&
      fullReceipt
    )
      reusableFullIds.add(run.id);
  }
  return { ids, reusableFullIds };
}

function checkRuns(
  runner: Runner,
  repository: string,
  defaultBranch: string,
  listed: readonly ListedRun[],
  plan: LandingPlan,
  bound: BoundRuns,
  reusePullRequestDuplicates: boolean,
): string | undefined {
  const covering: ListedRun[] = [];
  for (const run of listed.filter((entry) => landingWorkflows.has(entry.path))) {
    const unpinnedPullRequestDuplicate =
      run.path === PULL_REQUEST_WORKFLOW &&
      !bound.ids.has(run.id) &&
      reusePullRequestDuplicates &&
      bound.reusableFullIds.size > 0;
    if (run.status !== 'completed') {
      if (!unpinnedPullRequestDuplicate) return `run ${run.id} (${run.path}) has not finished`;
      const problem = jobsProblem(runner, repository, run, true);
      if (problem !== undefined) return problem;
      continue;
    }
    if (run.conclusion === 'success') {
      const problem = jobsProblem(runner, repository, run);
      if (problem !== undefined) return problem;
      const covers =
        run.path === TARGETED_WORKFLOW
          ? !plan.requiresFullRun && run.title === targetedRunName(plan.digest)
          : bound.ids.has(run.id);
      if (covers) covering.push(run);
      continue;
    }
    if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') continue;
    // A red run may stay beside a green covering run when `main` has all of its failures; it never
    // covers a head itself.
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
    } catch (error) {
      return `run ${run.id} is red and could not be compared with main: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (plan.requiresFullRun) {
    if (!covering.some((run) => run.path === FULL_WORKFLOW))
      return 'the evidence plan requires a full main.yml run bound by a CI evidence identity, and none is green on the head';
  } else if (covering.length === 0)
    return 'no green run covers the head: a bound main.yml or pull-request.yml run, or a targeted-checks.yml run named for the plan digest';
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

  let bound: BoundRuns = { ids: new Set(), reusableFullIds: new Set() };
  if ((request.ciEvidence ?? []).length > 0) {
    const result = await checkDigests(
      verification,
      listed,
      dependencies.ciProvider ??
        createGitHubCiEvidenceProvider({
          repository: request.repository,
          cwd: request.worktree,
        }),
    );
    if (typeof result === 'string') return result;
    bound = result;
  }

  const changed = changedPaths(runner, request.worktree, request.base, request.revision);
  if (typeof changed === 'string') return changed;
  const plan = landingPlan(changed);
  const runProblem = checkRuns(
    runner,
    request.repository,
    route.defaultBranch,
    listed,
    plan,
    bound,
    route.integrationTree === request.integrationTree && allowsPullRequestDuplicateReuse(changed),
  );
  if (runProblem !== undefined) return runProblem;

  const door = plan.oneWayDoors[0];
  if (door !== undefined && route.route !== 'pull-request')
    return `${door.path} is a one-way door (${door.rule}) and must go through a pull request, not a branch merge`;

  const interfaces = interfacePaths(plan.changed);
  if (interfaces.length > 0) {
    const path = designVerdictPath(verification.state.stateDirectory, request.revision);
    let text: string | undefined;
    try {
      text = (dependencies.readVerdicts ?? ((file) => readFileSync(file, 'utf8')))(path);
    } catch {
      text = undefined;
    }
    if (text === undefined)
      return `${interfaces[0]} is an interface path and ${path} records no design verdict for the head`;
    let failing = failingVerdictRows(text);
    const read = dependencies.readVerdicts ?? ((file: string) => readFileSync(file, 'utf8'));
    try {
      const exclusions = read(path.replace(/\.verdicts$/, '.exclusions.json'));
      if (exclusions !== undefined) {
        const binding: unknown = JSON.parse(exclusions);
        if (!binding || typeof binding !== 'object' || Array.isArray(binding))
          return 'invalid design exclusion binding';
        const record = binding as Record<string, unknown>;
        if (
          Object.keys(record).toSorted().join(',') !== 'attestation,recordedDigest' ||
          typeof record.attestation !== 'string' ||
          record.recordedDigest !== designDigest(text)
        )
          return 'invalid design exclusion binding';
        const rows = read(path.replace(/\.verdicts$/, '.rows'));
        const ledger = read(path.replace(/\.verdicts$/, '.ledger'));
        failing =
          rows === undefined || ledger === undefined
            ? ['missing design exclusion evidence']
            : exclusionResult(
                record.attestation,
                request.revision,
                route.incomingBase ?? '',
                rows,
                ledger,
              );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return 'design exclusion evidence could not be read';
    }
    if (failing.length > 0) return `the design verdict has failing rows: ${failing.join('; ')}`;
  }
  return undefined;
}
