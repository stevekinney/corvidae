#!/usr/bin/env bun
// Chef delivery request: the writer and the dry check of the request `deliver.ts` lands from, so a
// batch dispatched by hand reaches `deliver.ts --branch|--pr` without a hand-built JSON file.
//
// Usage:
//   bun scripts/chef/delivery-request.ts prepare --branch <branch> --head <sha> --worktree <path>
//       --base <sha> --run <id> [--project <name>] --issue <ID> [--issue <ID> ...]
//       [--route branch|pull-request] [--no-track] [--no-close] [--leave-open <ID> ...]
//       [--classification behavior|no-behavior] [--context <json>] [--source-criteria <json>] [--wait-minutes <n>]
//       [--config <file>] [--json]
//   bun scripts/chef/delivery-request.ts check --file <json> --digest <sha256>
//       [--head <sha>] [--state-directory <dir>] [--config <file>] [--json]
//
// `prepare` is the coordinator's acceptance of a pushed head. It writes
// `<main checkout>/tmp/chef/requests/<operation>-<digest prefix>.json` (outside every worktree, as
// `deliver.ts` requires), records the coordinator's approval of it in the execution state, dispatches
// the one `main.yml` run the request binds, and prints the file, its sha256 digest and the run id:
//
//   1. Each `--issue` is read from Linear through `brief.ts`'s `readBatchBrief` (criteria from the
//      description, blockers, source digests): an unreadable or blocked issue refuses the request,
//      and there is no offline criteria file, because an Assignment's revision, dependencies and
//      source digests exist only on that read. An issue that links a design needs `--context`, the
//      same file `brief.ts --context` takes. The coordinator adds `merge` to each assignment's
//      consequential actions (the acceptance this command records) and re-digests it.
//   2. The evidence plan is computed from `git diff <base>...<head>` (`computeEvidencePlan`). Every
//      acceptance criterion of every member becomes one provider obligation on one `main.yml` job
//      (`Root checks, scripts tests, audit`, `EVIDENCE_JOB`), phase `pre-integration`. What the run
//      proves is the whole green `main.yml` run on the head, bound by an evidence identity; what the
//      coordinator attests is that each criterion was accepted. No criterion has a test of its own.
//   3. The identity, its request key and the batch plan digest are computed before anything is sent.
//      `targeted-run.ts` dispatches `main.yml` with `verification_request`, `verification_plan` and
//      `verification_base` unless a run with that key already exists. Before it sends anything,
//      `prepare` saves the members it built beside the request (`<operation>.pending.json`), and a
//      second `prepare` with the same arguments loads them instead of reading Linear again, so the
//      key, and with it the run, is the same. The run id and the runner of the evidence job are
//      known only afterwards, and both enter the digest-pinned file: `prepare` polls (up to
//      `--wait-minutes`, default 10) until the job has a runner. If that expires, run the same
//      command again; nothing is dispatched twice. (`ci-evidence-run.ts` is a second sender of the
//      same inputs, through the provider's `dispatch`; do not use both for one head.)
//   4. The branch must contain `--base`: a workflow dispatch checks out the branch head, so the
//      request's integration tree is the head's tree, and `deliver.ts` compares it with
//      `git merge-tree --write-tree <base> <head>`. After `prepare`, dispatch nothing else on the
//      branch: a newer dispatch on a ref cancels this run, and a red or cancelled bound run cannot
//      be replaced for the same head (a second run with the same key is ambiguous). Push a new head
//      and prepare again. The execution state's authority is the project lease's
//      (`project:<id>`, owner `linear:<run>`, from `linear.ts lease`) when `--project` is given.
//      Without a project, every member instead retains its current `issue:<identifier>` claim.
//   Members are tracked and closed on delivery by default (`--no-track` tracks none, `--no-close`
//   closes none, `--leave-open <ID>` keeps one open). `--route` is the approval's route, `branch`
//   unless the head lands by pull request; one-way doors need `pull-request`.
//
// `check` runs what `deliver.ts` runs before it merges, without merging: it loads the request,
// derives the current base, head and integration tree from git (`git fetch origin <default>`;
// `--head`, else the worktree's HEAD), then `validateDeliveryVerification`,
// `validateDeliveryCiEvidence` and `validateLandingEvidence`, and prints each refusal. Run it from
// a checkout that has the head fetched. A base that has moved needs no new evidence run (owner
// decision, 2026-11-21): `check` accepts it, as `deliver.ts` does, when the request's base is an
// ancestor of the current one and the head still merges into it without a conflict
// (`moved-base.ts`). The lease and the pull-request threads are `deliver.ts`'s own steps.
//
// Exit codes: `prepare` 0 request written and run dispatched or reused, 1 refused (a git, Linear,
// lease, authority or evidence condition, printed); `check` 0 when `deliver.ts` would proceed past
// verification, 1 with each refusal printed; both 2 on invalid usage.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { readBatchBrief, refusalReasons, sourceContext } from './brief.ts';
import { createGitHubCiEvidenceProvider } from './ci-evidence-github.ts';
import {
  CiEvidenceError,
  ciEvidenceRequestKey,
  type CiEvidenceProvider,
  type CiEvidenceRequest,
  type CiEvidenceRun,
  type PullRequestSourceCriteriaBinding,
} from './ci-evidence.ts';
import {
  batchVerificationPlanDigest,
  readDeliveryRequest,
  validateFrozenDeliveryMember,
  type DeliveryMember,
  type DeliveryRequest,
} from './delivery-completion.ts';
import {
  loadDeliveryVerification,
  prepareDeliveryVerification,
  validateDeliveryCiEvidence,
  validateDeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import { repositoryContext } from './evidence-plan.ts';
import { EvidenceRequestError } from './evidence.ts';
import {
  createExecutionStateStore,
  currentAuthority,
  ExecutionStateError,
  readExecutionSnapshot,
  recordMutationIntent,
  requireAuthority,
  withProviderTransitionLock,
  type Authority,
  type ExecutionStateStore,
} from './execution-state.ts';
import { validateLandingEvidence } from './landing-evidence.ts';
import { changedPaths } from './landing-plan.ts';
import { createClient, LinearError, readProject } from './linear.ts';
import { acceptMovedMain } from './moved-base.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  UsageError,
  type Runner,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';
import { inputsFromPlan } from './targeted-inputs.ts';
import { dispatchVerificationRun, type VerificationBinding } from './targeted-run.ts';
import {
  computeEvidencePlan,
  createVerificationPlan,
  digest,
  gateAssignment,
  supportsAutomaticPullRequestEvidence,
  type Assignment,
  type EvidencePlan,
} from './verification-plan.ts';

export { UsageError };

/**
 * The `main.yml` job every criterion's obligation names. It has no `needs`, so it is queued when
 * the run starts rather than after another job, and its runner is known soonest.
 */
export const EVIDENCE_JOB = 'Root checks, scripts tests, audit';
const EVIDENCE_WORKFLOW = 'Main';
const EVIDENCE_WORKFLOW_PATH = '.github/workflows/main.yml';
const PULL_REQUEST_WORKFLOW = 'Pull request';
const PULL_REQUEST_WORKFLOW_PATH = '.github/workflows/pull-request.yml';
const PULL_REQUEST_AGGREGATE = 'Evidence aggregate';
const PULL_REQUEST_RECEIPT_JOBS = ['static', 'workspaces', 'tests', 'browser-selection', 'browser'];

const ISSUE = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const POLL_INTERVAL_MILLISECONDS = 10_000;

type DeliveryRoute = 'branch' | 'pull-request';

export interface PrepareOptions {
  branch: string;
  head: string;
  worktree: string;
  base: string;
  run: string;
  /** A project lease, or absent when each issue claim is the delivery authority. */
  project?: string | undefined;
  issues: string[];
  route: DeliveryRoute;
  track: boolean;
  close: boolean;
  leaveOpen: string[];
  classification?: 'behavior' | 'no-behavior' | undefined;
  /** The verified design sources `brief.ts --context` takes; an issue that links a design needs them. */
  sourceContext?: ReadonlyMap<string, string> | undefined;
  /** Coordinator-approved, per-member test bindings required before automatic PR reuse. */
  sourceCriteria?: PullRequestSourceCriteriaBinding | undefined;
  waitMinutes: number;
}

export interface PrepareResult {
  file: string;
  digest: string;
  runId: number;
  operationId: string;
  route: DeliveryRoute;
  environment: string;
  dispatched: boolean;
  command: string[];
}

/** One job of a workflow run as `gh api .../runs/<id>/jobs` lists it. */
interface RunJob {
  name: string;
  runner: string;
  startedAt: string;
}

export interface PrepareDependencies {
  /** Answers `git` and `gh`; its working directory is each call's `cwd`. */
  runner: Runner;
  repository: string;
  defaultBranch: string;
  mainCheckout: string;
  state: ExecutionStateStore;
  /** The Linear assignments of `issues` and why any is refused; the command line wraps `readBatchBrief`. */
  readAssignments: (input: {
    issues: string[];
    repository: string;
    base: string;
    run: string;
    classification?: 'behavior' | 'no-behavior' | undefined;
    sourceContext?: ReadonlyMap<string, string> | undefined;
  }) => Promise<{ assignments: Assignment[]; refusals: string[] }>;
  /** The execution-state resource of the project lease `run` holds, or a thrown reason. */
  leaseResource: (project: string, run: string) => Promise<string>;
  plan: (changed: string[], worktree: string) => EvidencePlan;
  provider: Pick<CiEvidenceProvider, 'findRuns' | 'findAutomaticPullRequestRuns'>;
  readJobs: (runId: number) => RunJob[];
  wait: (milliseconds: number) => Promise<void>;
  dispatch: (ref: string, binding: VerificationBinding, cwd: string) => string[];
  /** The current time in epoch milliseconds, read when the saved members are written and read. */
  now: () => number;
}

function operationIdOf(branch: string, head: string): string {
  return `delivery:${branch.replace(/[^A-Za-z0-9._-]/g, '-')}:${head.slice(0, 12)}`;
}

function git(runner: Runner, cwd: string, args: string[]): string {
  const result = runner(['git', ...args], { cwd });
  if (result.code !== 0)
    throw new UsageError(
      `git ${args[0] ?? ''} failed (exit ${result.code}): ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return result.stdout.trim();
}

function validatePrepare(options: PrepareOptions): void {
  if (!/^[\w./-]+$/.test(options.branch))
    throw new UsageError(`'${options.branch}' is not a branch.`);
  if (!COMMIT.test(options.head)) throw new UsageError('--head must be a full commit SHA.');
  if (!COMMIT.test(options.base)) throw new UsageError('--base must be a full commit SHA.');
  if (options.issues.length === 0) throw new UsageError('--issue is required, once per member.');
  if (
    options.issues.some((identifier) => !ISSUE.test(identifier)) ||
    new Set(options.issues).size !== options.issues.length
  )
    throw new UsageError('--issue takes distinct identifiers such as COR-1.');
  const stray = options.leaveOpen.filter((identifier) => !options.issues.includes(identifier));
  if (stray.length > 0) throw new UsageError(`--leave-open names no member: ${stray.join(', ')}.`);
  if (!options.track && options.close)
    throw new UsageError('--no-track needs --no-close: an issue is closed only when tracked.');
  if (!Number.isSafeInteger(options.waitMinutes) || options.waitMinutes < 0)
    throw new UsageError('--wait-minutes must be a whole number of minutes.');
}

function freezeSourceCriteriaBinding(
  value: PullRequestSourceCriteriaBinding | undefined,
  members: readonly DeliveryMember[],
): PullRequestSourceCriteriaBinding | undefined {
  if (value === undefined) return undefined;
  if (value.version !== 1 || !Array.isArray(value.members))
    throw new UsageError('--source-criteria must be a version 1 member binding.');
  const expected = members.map((member) => ({
    identifier: member.assignment.identity.identifier,
    criteria:
      member.assignment.criteria.length === 0 && member.assignment.classification === 'no-behavior'
        ? ['STATIC']
        : member.assignment.criteria.map((criterion) => criterion.id),
  }));
  if (value.members.length !== expected.length)
    throw new UsageError('--source-criteria must bind every accepted member.');
  const frozen = value.members.map((member, index) => {
    const accepted = expected[index];
    if (
      accepted === undefined ||
      member.identifier !== accepted.identifier ||
      !Array.isArray(member.criteria) ||
      member.criteria.length !== accepted.criteria.length
    )
      throw new UsageError('--source-criteria does not match the accepted member order.');
    const criteria = member.criteria.map((criterion) => {
      if (
        typeof criterion?.criterionId !== 'string' ||
        !Array.isArray(criterion.testFiles) ||
        criterion.testFiles.length === 0 ||
        !criterion.testFiles.every((path) => /^[A-Za-z0-9_./-]+\.test\.ts$/.test(path)) ||
        new Set(criterion.testFiles).size !== criterion.testFiles.length
      )
        throw new UsageError('--source-criteria contains an invalid test-file binding.');
      return { criterionId: criterion.criterionId, testFiles: [...criterion.testFiles].toSorted() };
    });
    if (
      criteria
        .map((criterion) => criterion.criterionId)
        .toSorted()
        .join() !== [...accepted.criteria].toSorted().join() ||
      new Set(criteria.map((criterion) => criterion.criterionId)).size !== criteria.length
    )
      throw new UsageError('--source-criteria must bind every criterion exactly once.');
    return {
      identifier: member.identifier,
      criteria: criteria.toSorted((left, right) =>
        left.criterionId.localeCompare(right.criterionId),
      ),
    };
  });
  return { version: 1, members: frozen };
}

/** The assignments, accepted for `merge`: one consequential action added, the identity re-digested. */
function acceptedAssignment(assignment: Assignment): Assignment {
  const accepted = structuredClone(assignment);
  if (!accepted.allowedConsequentialActions.includes('merge'))
    accepted.allowedConsequentialActions.push('merge');
  accepted.identity.digest = digest(
    JSON.stringify({ ...accepted, identity: { ...accepted.identity, digest: undefined } }),
  );
  return accepted;
}

function membersOf(
  assignments: Assignment[],
  options: PrepareOptions,
  plan: EvidencePlan,
  inputs: string[],
  authorities?: readonly Authority[],
): DeliveryMember[] {
  const reason = `main.yml job "${EVIDENCE_JOB}" of the run bound to this head; evidence plan: ${plan.changed.length} changed files, ${plan.unit_tests.length} unit-test lanes, full run ${plan.requires_full_run ? `required (${plan.full_run_rules.map(({ rule }) => rule).join('; ')})` : 'not required'}.`;
  return assignments.map((assignment, index) => {
    const base = createVerificationPlan({
      assignment,
      commands: [],
      policy: 'chef delivery request: one main.yml job per criterion',
    });
    const criteria =
      assignment.criteria.length === 0 && assignment.classification === 'no-behavior'
        ? ['STATIC']
        : assignment.criteria.map((criterion) => criterion.id);
    const identifier = assignment.identity.identifier;
    return {
      assignment,
      ...(authorities === undefined ? {} : { authority: authorities[index] }),
      plan: {
        version: base.version,
        // The base plan's per-risk obligations are replaced by one bound job per criterion, so a
        // risk it marked covered is not covered by anything this request names.
        risks: Object.fromEntries(
          Object.entries(base.risks).map(([risk, state]) => [
            risk,
            state === 'covered' ? 'unknown' : state,
          ]),
        ) as typeof base.risks,
        invalidatedBy: base.invalidatedBy,
        obligations: criteria.map((criterionId) => ({
          criterionId,
          risk: 'static-documentation' as const,
          commandOrProviderJob: EVIDENCE_JOB,
          expectedInventory: [],
          relevantInputs: inputs,
          environmentToolchain: 'GitHub-hosted runner',
          executionBoundary: 'provider' as const,
          producer: 'scripts/chef/delivery-request.ts',
          selectionReason: reason,
          evidenceKind: 'process-exit' as const,
          phase: 'pre-integration' as const,
        })),
      },
      providerRuns: [],
      track: options.track,
      requestedClose: options.track && options.close && !options.leaveOpen.includes(identifier),
      changes: [`Branch ${options.branch} at ${options.head}.`],
      blockers: [],
    };
  });
}

/** Automatic PR evidence is useful only for a scoped plan and its complete concrete inventory. */
function reusablePullRequestRun(
  plan: EvidencePlan,
  runs: readonly CiEvidenceRun[],
  binding: PullRequestSourceCriteriaBinding | undefined,
): CiEvidenceRun | undefined {
  if (
    !supportsAutomaticPullRequestEvidence(plan) ||
    inputsFromPlan(plan).undispatchable.length > 0 ||
    runs.length !== 1
  )
    return undefined;
  const candidateRun = runs[0];
  if (candidateRun === undefined || !candidateRun.jobs.includes(PULL_REQUEST_AGGREGATE))
    return undefined;
  if (
    PULL_REQUEST_RECEIPT_JOBS.some((job) =>
      job === 'browser'
        ? !['success', 'not-applicable'].includes(candidateRun.receiptJobs[job] ?? '')
        : candidateRun.receiptJobs[job] !== 'success',
    ) ||
    Object.keys(candidateRun.receiptJobs).length !== PULL_REQUEST_RECEIPT_JOBS.length
  )
    return undefined;
  if (
    binding === undefined ||
    candidateRun.receiptTestFiles === undefined ||
    plan.unit_tests.some((lane) =>
      lane.paths.some(
        (path) =>
          !candidateRun.receiptTestFiles?.includes(
            lane.workspace ? `${lane.workspace}/${path}` : path,
          ),
      ),
    ) ||
    binding.members.some((member) =>
      member.criteria.some((criterion) =>
        criterion.testFiles.some((path) => !candidateRun.receiptTestFiles?.includes(path)),
      ),
    )
  )
    return undefined;
  return candidateRun;
}

function frozenFingerprint(members: readonly DeliveryMember[]): string {
  return digest(
    JSON.stringify(
      members.map(({ assignment, authority, plan }) => ({ assignment, authority, plan })),
    ),
  );
}

/** Holds every authority in a stable order while the provider transition spends its permission. */
async function withDeliveryAuthorityFences<T>(
  state: ExecutionStateStore,
  authorities: readonly Authority[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [
    ...new Map(authorities.map((authority) => [authority.resource, authority])).values(),
  ].toSorted((left, right) => left.resource.localeCompare(right.resource));
  const enter = async (index: number): Promise<T> => {
    if (index === ordered.length) return operation();
    const authority = ordered[index];
    if (authority === undefined) throw new UsageError('delivery authority fence is empty.');
    return withProviderTransitionLock(state, authority.resource, async () => {
      requireAuthority(state, authority);
      return enter(index + 1);
    });
  };
  return enter(0);
}

/** Writes `text` to `path` in one rename, so a reader never sees half a file. */
function writeWhole(path: string, text: string): void {
  const staged = `${path}.${crypto.randomUUID()}`;
  writeFileSync(staged, text);
  renameSync(staged, path);
}

/** How long an attempt's saved members are reused: the lifetime of the project lease. */
const PENDING_LIFETIME_MILLISECONDS = 12 * 60 * 60 * 1000;

/**
 * The members an earlier attempt saved for `fingerprint` within the last lease lifetime, or
 * `undefined` when there are none.
 */
function readPending(
  path: string,
  fingerprint: string,
  now: number,
): { members?: DeliveryMember[]; changed: boolean } {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      fingerprint?: unknown;
      members?: unknown;
      savedAt?: unknown;
    };
    const fresh =
      typeof saved.savedAt === 'number' && now - saved.savedAt <= PENDING_LIFETIME_MILLISECONDS;
    if (!fresh) return { changed: false };
    if (saved.fingerprint !== fingerprint) return { changed: true };
    return Array.isArray(saved.members)
      ? { members: saved.members as DeliveryMember[], changed: false }
      : { changed: true };
  } catch {
    return { changed: false };
  }
}

/** Whether an earlier attempt recorded that it dispatched the run for `requestKey`. */
function dispatchAttempted(path: string, requestKey: string): boolean {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { dispatchedRequestKey?: unknown };
    return saved.dispatchedRequestKey === requestKey;
  } catch {
    return false;
  }
}

async function poll<T>(
  attempts: number,
  dependencies: Pick<PrepareDependencies, 'wait'>,
  read: () => Promise<T | undefined> | T | undefined,
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    if (attempt < attempts) await dependencies.wait(POLL_INTERVAL_MILLISECONDS);
  }
  return undefined;
}

/** Writes the request, its approval and its bound run. Throws a `UsageError` for any refusal. */
export async function prepare(
  options: PrepareOptions,
  dependencies: PrepareDependencies,
): Promise<PrepareResult> {
  validatePrepare(options);
  const sourceCriteriaInput = structuredClone(options.sourceCriteria);
  const { runner, repository } = dependencies;
  const cwd = options.worktree;
  const worktreeHead = git(runner, cwd, ['rev-parse', 'HEAD']);
  if (worktreeHead !== options.head)
    throw new UsageError(
      `${cwd} is at ${worktreeHead.slice(0, 12)}, not --head ${options.head.slice(0, 12)}.`,
    );
  const published = runner(
    ['gh', 'api', `repos/${repository}/git/ref/heads/${encodeURIComponent(options.branch)}`],
    { cwd },
  );
  let publishedHead = '';
  try {
    publishedHead =
      (JSON.parse(published.stdout) as { object?: { sha?: string } }).object?.sha ?? '';
  } catch {
    publishedHead = '';
  }
  if (published.code !== 0 || publishedHead !== options.head)
    throw new UsageError(
      `origin/${options.branch} is ${publishedHead.slice(0, 12) || 'unreadable'}, not --head ${options.head.slice(0, 12)}: push the head first.`,
    );
  if (
    runner(['git', 'merge-base', '--is-ancestor', options.base, options.head], { cwd }).code !== 0
  )
    throw new UsageError(
      `--base ${options.base.slice(0, 12)} is not an ancestor of the head: merge origin/${dependencies.defaultBranch} into the branch and push before preparing.`,
    );
  const integrationTree =
    git(runner, cwd, ['merge-tree', '--write-tree', options.base, options.head]).split('\n')[0] ??
    '';
  const headTree = git(runner, cwd, ['rev-parse', `${options.head}^{tree}`]);
  if (integrationTree !== headTree)
    throw new UsageError(
      'the head does not contain --base, so the dispatched run (which checks out the head) would not test the integration tree.',
    );

  const changed = changedPaths(runner, cwd, options.base, options.head);
  if (typeof changed === 'string') throw new UsageError(changed);
  // Every changed path, deletions included: deleting a file can require a full run as surely as
  // editing it. The plan hashes only the paths that still exist as its relevant inputs.
  const plan = dependencies.plan(changed, cwd);
  const kept = git(runner, cwd, [
    'diff',
    '--name-only',
    '--diff-filter=d',
    `${options.base}...${options.head}`,
  ])
    .split('\n')
    .filter((path) => path !== '');

  const operationId = operationIdOf(options.branch, options.head);
  const directory = join(dependencies.mainCheckout, 'tmp', 'chef', 'requests');
  const pendingFile = join(directory, `${operationId.replaceAll(':', '-')}.pending.json`);
  const fingerprint = digest(
    JSON.stringify([
      options.branch,
      options.head,
      options.base,
      options.route,
      options.issues,
      options.track,
      options.close,
      options.leaveOpen,
      options.classification ?? null,
      sourceCriteriaInput ?? null,
    ]),
  );
  let members: DeliveryMember[] | undefined;
  let sourceCriteria: PullRequestSourceCriteriaBinding | undefined;
  let authority: Authority | undefined;
  // The operation lock freezes current Linear assignments and their held authorities before the
  // request-key provider transition. A retry must prove the same batch still exists; it cannot
  // silently spend CI using an earlier member list after Linear changed.
  await withProviderTransitionLock(
    dependencies.state,
    `delivery-operation:${operationId}`,
    async () => {
      const read = await dependencies.readAssignments({
        issues: options.issues,
        repository,
        base: options.base,
        run: options.run,
        classification: options.classification,
        sourceContext: options.sourceContext,
      });
      const accepted = read.assignments.map(acceptedAssignment);
      const refused = [
        ...read.refusals,
        ...accepted.flatMap((assignment) => {
          const gate = gateAssignment(assignment, 'held');
          return gate.dispatchable ? [] : [refusalReasons([assignment], [gate])];
        }),
      ];
      if (refused.length > 0)
        throw new UsageError(`Refused: an assignment is not dispatchable.\n${refused.join('\n')}`);
      if (
        accepted.map((assignment) => assignment.identity.identifier).join() !==
        options.issues.join()
      )
        throw new UsageError('the assignments read do not match --issue, in order.');
      let authorities: Authority[] | undefined;
      if (options.project === undefined) {
        try {
          authorities = accepted.map((assignment) =>
            currentAuthority(dependencies.state, {
              resource: `issue:${assignment.identity.identifier}`,
              runId: options.run,
              ownerId: `linear:${options.run}`,
            }),
          );
        } catch (error) {
          throw new UsageError(
            `run ${options.run} does not hold every current issue claim (${error instanceof Error ? error.message : String(error)}); claim each member before preparing.`,
          );
        }
      } else {
        const resource = await dependencies.leaseResource(options.project, options.run);
        try {
          authority = currentAuthority(dependencies.state, {
            resource,
            runId: options.run,
            ownerId: `linear:${options.run}`,
          });
        } catch (error) {
          throw new UsageError(
            `run ${options.run} has no current local authority for ${resource} (${error instanceof Error ? error.message : String(error)}); run linear.ts lease on this host first.`,
          );
        }
      }
      const current = membersOf(accepted, options, plan, kept, authorities);
      const pending = readPending(pendingFile, fingerprint, dependencies.now());
      const frozen = pending.members ?? current;
      const frozenAuthority = authorities?.[0] ?? authority;
      if (frozenAuthority === undefined)
        throw new UsageError('delivery operation did not retain an authority and frozen members.');
      for (const member of frozen)
        validateFrozenDeliveryMember(member, {
          repository,
          base: options.base,
          authority: frozenAuthority,
        });
      if (
        pending.changed ||
        (pending.members !== undefined &&
          frozenFingerprint(pending.members) !== frozenFingerprint(current))
      )
        throw new UsageError(
          'the accepted batch changed after its operation freeze; push a new head and prepare a fresh identity.',
        );
      sourceCriteria = freezeSourceCriteriaBinding(sourceCriteriaInput, frozen);
      members = frozen;
      authority = authorities?.[0] ?? authority;
      if (pending.members === undefined) {
        mkdirSync(directory, { recursive: true });
        writeWhole(
          pendingFile,
          JSON.stringify({ fingerprint, members, savedAt: dependencies.now() }),
        );
      }
    },
  );
  if (members === undefined || authority === undefined)
    throw new UsageError('delivery operation did not retain an authority and frozen members.');
  const frozenMembers = members;
  const deliveryAuthority = authority;
  for (const member of frozenMembers)
    validateFrozenDeliveryMember(member, {
      repository,
      base: options.base,
      authority: deliveryAuthority,
    });

  const identityInput = {
    repository,
    resource: authority.resource,
    base: options.base,
    candidate: options.head,
    integrationTree,
    verificationPlanDigest: batchVerificationPlanDigest(frozenMembers),
    workflow: EVIDENCE_WORKFLOW,
    workflowPath: EVIDENCE_WORKFLOW_PATH,
    workflowRevision: options.head,
    event: 'workflow_dispatch',
    ...(sourceCriteria === undefined ? {} : { sourceCriteria }),
  } satisfies Omit<CiEvidenceRequest, 'requestKey'>;
  const manualIdentity: CiEvidenceRequest = {
    ...identityInput,
    requestKey: ciEvidenceRequestKey(identityInput),
  };
  let identity = manualIdentity;
  let automaticRun: CiEvidenceRun | undefined;
  const attempts = Math.ceil((options.waitMinutes * 60_000) / POLL_INTERVAL_MILLISECONDS);

  // One dispatch per request key, ever: the attempt is recorded under the key's lock before the
  // workflow is sent, so an overlapping `prepare`, or a retry that runs before GitHub lists the
  // first run, polls for that run instead of sending a second one that would cancel it.
  let dispatched = false;
  let command: string[] = [];
  await withProviderTransitionLock(
    dependencies.state,
    `delivery-dispatch:${identity.requestKey}`,
    async () =>
      withDeliveryAuthorityFences(
        dependencies.state,
        [deliveryAuthority, ...frozenMembers.flatMap((member) => member.authority ?? [])],
        async () => {
          if (
            options.route === 'pull-request' &&
            !plan.requires_full_run &&
            !dispatchAttempted(pendingFile, manualIdentity.requestKey) &&
            dependencies.provider.findAutomaticPullRequestRuns !== undefined
          ) {
            // A provider error is not proof and cannot block the frozen manual request path.
            try {
              const reusable = reusablePullRequestRun(
                plan,
                await dependencies.provider.findAutomaticPullRequestRuns({
                  repository,
                  resource: deliveryAuthority.resource,
                  base: options.base,
                  candidate: options.head,
                  integrationTree,
                  workflow: PULL_REQUEST_WORKFLOW,
                  workflowPath: PULL_REQUEST_WORKFLOW_PATH,
                }),
                sourceCriteria,
              );
              if (reusable !== undefined) {
                const automaticIdentity = {
                  repository,
                  resource: deliveryAuthority.resource,
                  base: options.base,
                  candidate: options.head,
                  integrationTree,
                  verificationPlanDigest: reusable.verificationPlanDigest,
                  workflow: PULL_REQUEST_WORKFLOW,
                  workflowPath: PULL_REQUEST_WORKFLOW_PATH,
                  workflowRevision: reusable.workflowRevision,
                  event: 'pull_request' as const,
                  ...(sourceCriteria === undefined ? {} : { sourceCriteria }),
                };
                identity = {
                  ...automaticIdentity,
                  requestKey: ciEvidenceRequestKey(automaticIdentity),
                };
                automaticRun = reusable;
                return;
              }
            } catch {
              // The manually bound full run remains the only fallback after an unreadable receipt.
            }
          }
          const found = await dependencies.provider.findRuns(identity);
          if (found.length > 1)
            throw new UsageError(
              `${found.length} runs carry request key ${identity.requestKey}: a second dispatch for this head cannot be told from the first; push a new head.`,
            );
          if (found.length > 0 || dispatchAttempted(pendingFile, identity.requestKey)) return;
          writeWhole(
            pendingFile,
            JSON.stringify({
              fingerprint,
              members,
              savedAt: dependencies.now(),
              dispatchedRequestKey: identity.requestKey,
            }),
          );
          command = dependencies.dispatch(
            options.branch,
            {
              request: identity.requestKey,
              plan: identity.verificationPlanDigest,
              base: options.base,
            },
            cwd,
          );
          dispatched = true;
        },
      ),
  );
  const observed =
    automaticRun ??
    (await poll(attempts, dependencies, async () => {
      try {
        const runs = await dependencies.provider.findRuns(identity);
        return runs.length === 1 ? runs[0] : undefined;
      } catch {
        return undefined;
      }
    }));
  if (observed === undefined)
    throw new UsageError(
      `no run carries request key ${identity.requestKey} yet; run the same command again (it dispatches nothing twice).`,
    );
  if ('state' in observed && (observed.state === 'failed' || observed.state === 'canceled'))
    throw new UsageError(
      `run ${observed.id} ${observed.state}: it cannot be replaced for this head; push a new head and prepare again.`,
    );
  const runId = observed.id;
  const job = await poll(attempts, dependencies, () =>
    dependencies
      .readJobs(runId)
      .find(
        (candidate) =>
          candidate.name === (automaticRun === undefined ? EVIDENCE_JOB : PULL_REQUEST_AGGREGATE) &&
          candidate.runner !== '',
      ),
  );
  if (job === undefined)
    throw new UsageError(
      `run ${runId}'s job "${automaticRun === undefined ? EVIDENCE_JOB : PULL_REQUEST_AGGREGATE}" has no runner yet; run the same command again (it dispatches nothing twice).`,
    );

  const finished: DeliveryMember[] = members.map((member: DeliveryMember) => ({
    ...member,
    providerRuns: member.plan.obligations.map((obligation) => ({
      id: runId,
      ...(automaticRun === undefined ? {} : { attempt: automaticRun.attempt }),
      obligation: `${obligation.criterionId}:${obligation.commandOrProviderJob}`,
      job: automaticRun === undefined ? EVIDENCE_JOB : PULL_REQUEST_AGGREGATE,
      workflow: automaticRun === undefined ? EVIDENCE_WORKFLOW : PULL_REQUEST_WORKFLOW,
      workflowPath:
        automaticRun === undefined ? EVIDENCE_WORKFLOW_PATH : PULL_REQUEST_WORKFLOW_PATH,
      event: automaticRun === undefined ? 'workflow_dispatch' : 'pull_request',
    })),
  }));
  const request: DeliveryRequest = {
    repository,
    revision: options.head,
    base: options.base,
    integrationTree,
    environment: job.runner,
    authority,
    operationId,
    worktree: resolve(cwd),
    members: finished,
    ciEvidence: [identity],
  };
  const text = JSON.stringify(request);
  const requestDigest = digest(text);
  mkdirSync(directory, { recursive: true });
  const file = join(
    directory,
    `${operationId.replaceAll(':', '-')}-${requestDigest.slice(0, 12)}.json`,
  );
  writeWhole(file, text);
  readDeliveryRequest(file, requestDigest);

  const binding = {
    file,
    digest: requestDigest,
    stateDirectory: dependencies.state.stateDirectory,
  };
  await withProviderTransitionLock(
    dependencies.state,
    `delivery-operation:${operationId}`,
    async () => {
      await recordMutationIntent(dependencies.state, deliveryAuthority, {
        operationId,
        action: 'merge',
        intentFingerprint: digest(
          JSON.stringify([options.branch, options.head, options.base, options.route]),
        ),
      });
      const existing = readExecutionSnapshot(dependencies.state).operations[operationId]?.approval;
      if (existing === undefined)
        await prepareDeliveryVerification(
          binding,
          finished.map((member) => member.assignment),
          { route: options.route, action: 'merge' },
          { state: dependencies.state },
        );
      else if (existing.requestDigest !== requestDigest || existing.route !== options.route)
        throw new UsageError(
          `${operationId} is already approved for another request (${existing.requestDigest.slice(0, 12)}, ${existing.route}); an approval is written once: push a new head.`,
        );
    },
  );
  return {
    file,
    digest: requestDigest,
    runId,
    operationId,
    route: options.route,
    environment: job.runner,
    dispatched,
    command,
  };
}

export interface CheckOptions {
  file: string;
  digest: string;
  stateDirectory?: string | undefined;
  head?: string | undefined;
}

export interface CheckDependencies {
  runner: Runner;
  defaultBranch: string;
  verification: Partial<DeliveryVerificationDependencies>;
  /** The landing check's own provider, when the verification one is not the one to use. */
  readVerdicts?: (path: string) => string | undefined;
}

/** Every refusal `deliver.ts` would raise at its verification step; empty when it would proceed. */
export async function check(
  options: CheckOptions,
  dependencies: CheckDependencies,
): Promise<string[]> {
  const { runner, defaultBranch } = dependencies;
  let loaded;
  try {
    loaded = loadDeliveryVerification(
      {
        file: options.file,
        digest: options.digest,
        ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
      },
      dependencies.verification,
    );
  } catch (error) {
    return [`the request does not load: ${error instanceof Error ? error.message : String(error)}`];
  }
  const { request } = loaded;
  const cwd = request.worktree;
  let route: string | undefined;
  try {
    route = readExecutionSnapshot(loaded.state).operations[request.operationId]?.approval?.route;
  } catch (error) {
    return [
      `the execution state could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (route !== 'branch' && route !== 'pull-request')
    return ['the request has no coordinator approval binding, so deliver.ts refuses it'];
  const problems: string[] = [];
  const fetched = runner(['git', 'fetch', 'origin', defaultBranch], { cwd });
  if (fetched.code !== 0)
    return [
      `git fetch origin ${defaultBranch} failed (exit ${fetched.code}): ${fetched.stderr.trim().split('\n')[0] ?? ''}`,
    ];
  const head = options.head ?? runner(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.trim();
  const base = runner(['git', 'rev-parse', `refs/remotes/origin/${defaultBranch}^{commit}`], {
    cwd,
  }).stdout.trim();
  const merged = runner(['git', 'merge-tree', '--write-tree', base, head], { cwd });
  const integrationTree = merged.stdout.split('\n')[0]?.trim() ?? '';
  if (
    !COMMIT.test(head) ||
    !COMMIT.test(base) ||
    merged.code !== 0 ||
    !/^[0-9a-f]{40,64}$/.test(integrationTree)
  )
    return [
      `the current base, head or integration tree could not be derived (merge-tree exit ${merged.code}): the head conflicts with origin/${defaultBranch} or is not fetched`,
    ];
  // A moved base never needs a new evidence run (owner decision, 2026-11-21): when the head merges
  // into the current base cleanly, the attested identity stands, as `deliver.ts` reads it.
  let attested = { base, tree: integrationTree };
  if (base !== request.base) {
    const moved = acceptMovedMain(
      (...args: string[]) => runner(['git', ...args], { cwd }),
      { base: request.base, tree: request.integrationTree },
      head,
      base,
      integrationTree,
    );
    if ('problem' in moved) return [`verification request has a stale base: ${moved.problem}`];
    attested = { base: request.base, tree: request.integrationTree };
  }
  // Each validator stands alone, and a thrown error is its refusal, as it is `deliver.ts`'s.
  const steps: (() => Promise<string | undefined> | string | undefined)[] = [
    () =>
      validateDeliveryVerification(
        loaded,
        {
          repository: request.repository,
          revision: head,
          base: attested.base,
          integrationTree: attested.tree,
          route,
          action: 'merge',
        },
        dependencies.verification,
      ),
    () => validateDeliveryCiEvidence(loaded, dependencies.verification),
    () =>
      validateLandingEvidence(
        loaded,
        { route, defaultBranch, integrationTree },
        {
          runner,
          ...(dependencies.verification.ciProvider === undefined
            ? {}
            : { ciProvider: dependencies.verification.ciProvider }),
          ...(dependencies.readVerdicts === undefined
            ? {}
            : { readVerdicts: dependencies.readVerdicts }),
        },
      ),
  ];
  for (const step of steps) {
    try {
      const problem = await step();
      if (problem !== undefined) problems.push(problem);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

/** The header's usage block. */
function usageText(): string {
  const lines = readFileSync(import.meta.path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === '// Usage:');
  const end = lines.findIndex((line, index) => index > start && line === '//');
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n');
}

function jobsOf(runner: Runner, repository: string, cwd: string, runId: number): RunJob[] {
  const result = runner(
    ['gh', 'api', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`],
    { cwd },
  );
  if (result.code !== 0) return [];
  try {
    const jobs = (JSON.parse(result.stdout) as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) return [];
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return jobs.map((job: Record<string, unknown>) => ({
      name: text(job['name']),
      runner: text(job['runner_name']),
      startedAt: text(job['started_at']),
    }));
  } catch {
    return [];
  }
}

/** The real collaborators, built only by the command line so that tests never reach a process. */
async function productionDependencies(
  configPath: string,
  worktree: string,
): Promise<PrepareDependencies> {
  const config = loadRepositoryConfig(configPath);
  const mainCheckout = resolveMainCheckout();
  const client = createClient();
  return {
    runner: defaultRunner,
    repository: config.repository,
    defaultBranch: config.defaultBranch,
    mainCheckout,
    state: createExecutionStateStore({
      stateDirectory: join(mainCheckout, 'tmp', 'chef', 'execution-state'),
      hostId: hostname(),
    }),
    readAssignments: async (input) => {
      const brief = await readBatchBrief(input.issues, {
        paths: [],
        verify: [],
        model: 'Sonnet',
        repository: input.repository,
        base: input.base,
        run: input.run,
        ...(input.classification === undefined ? {} : { classification: input.classification }),
        ...(input.sourceContext === undefined ? {} : { sourceContext: input.sourceContext }),
      });
      const refusals =
        brief.gates.every((gate) => gate.dispatchable) && brief.foreignClaim === undefined
          ? []
          : [
              refusalReasons(brief.assignments, brief.gates),
              ...(brief.foreignClaim === undefined ? [] : [brief.foreignClaim]),
            ].filter((line) => line !== '');
      return { assignments: brief.assignments, refusals };
    },
    leaseResource: async (project, holder) => {
      const { data } = await readProject(client, project);
      const lease = data['lease'] as { run: string; live: boolean } | null;
      if (lease === null || lease.run !== holder || !lease.live)
        throw new UsageError(
          `run ${holder} does not hold a live lease on ${project}: run linear.ts lease first.`,
        );
      return `project:${String(data['id'])}`;
    },
    plan: (changed, root) =>
      computeEvidencePlan(changed, repositoryContext(root, new Set<string>())),
    provider: createGitHubCiEvidenceProvider({
      repository: config.repository,
      cwd: worktree,
    }),
    readJobs: (runId) => jobsOf(defaultRunner, config.repository, worktree, runId),
    wait: (milliseconds) => Bun.sleep(milliseconds),
    now: () => Date.now(),
    dispatch: (ref, binding, cwd) =>
      dispatchVerificationRun(defaultRunner, ref, binding, { cwd }).command,
  };
}

export async function run(
  argv: string[],
  dependencies?: { prepare?: PrepareDependencies; check?: CheckDependencies },
): Promise<{ code: number; output: string }> {
  const [subcommand, ...rest] = argv;
  if (subcommand === '--help' || subcommand === 'help') return { code: 0, output: usageText() };
  if (subcommand !== 'prepare' && subcommand !== 'check')
    throw new UsageError('Give a subcommand, prepare or check; see --help.');
  const parsed = parseOptions(rest, {
    values: [
      'branch',
      'head',
      'worktree',
      'base',
      'run',
      'project',
      'route',
      'classification',
      'context',
      'source-criteria',
      'wait-minutes',
      'config',
      'file',
      'digest',
      'state-directory',
    ],
    repeated: ['issue', 'leave-open'],
    flags: ['no-track', 'no-close', 'json', 'help'],
  });
  if (parsed.flags.has('help')) return { code: 0, output: usageText() };
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const json = parsed.flags.has('json');
  const configPath = parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH;
  if (subcommand === 'check') {
    const file = resolve(requireOption(parsed, 'file'));
    if (!existsSync(file)) throw new UsageError(`No such request file: ${file}`);
    const config = loadRepositoryConfig(configPath);
    const stateDirectory =
      parsed.values['state-directory'] === undefined
        ? undefined
        : resolve(parsed.values['state-directory']);
    const verification: Partial<DeliveryVerificationDependencies> =
      stateDirectory === undefined
        ? {}
        : { state: createExecutionStateStore({ stateDirectory, hostId: hostname() }) };
    const problems = await check(
      {
        file,
        digest: requireOption(parsed, 'digest'),
        stateDirectory,
        head: parsed.values['head'],
      },
      dependencies?.check ?? {
        runner: defaultRunner,
        defaultBranch: config.defaultBranch,
        verification,
      },
    );
    return {
      code: problems.length === 0 ? 0 : 1,
      output: json
        ? JSON.stringify({ ok: problems.length === 0, problems })
        : problems.length === 0
          ? 'deliver.ts would proceed past verification.'
          : problems.map((problem) => `REFUSED: ${problem}`).join('\n'),
    };
  }
  const route = parsed.values['route'] ?? 'branch';
  if (route !== 'branch' && route !== 'pull-request')
    throw new UsageError('--route is branch or pull-request.');
  const classification = parsed.values['classification'];
  if (
    classification !== undefined &&
    classification !== 'behavior' &&
    classification !== 'no-behavior'
  )
    throw new UsageError('--classification must be behavior or no-behavior.');
  const worktree = resolve(requireOption(parsed, 'worktree'));
  const options: PrepareOptions = {
    branch: requireOption(parsed, 'branch'),
    head: requireOption(parsed, 'head'),
    worktree,
    base: requireOption(parsed, 'base'),
    run: requireOption(parsed, 'run'),
    project: parsed.values['project'],
    issues: parsed.repeated['issue'] ?? [],
    route,
    track: !parsed.flags.has('no-track'),
    close: !parsed.flags.has('no-close') && !parsed.flags.has('no-track'),
    leaveOpen: parsed.repeated['leave-open'] ?? [],
    classification,
    ...(parsed.values['context'] === undefined
      ? {}
      : { sourceContext: sourceContext(resolve(parsed.values['context'])) }),
    ...(parsed.values['source-criteria'] === undefined
      ? {}
      : {
          sourceCriteria: JSON.parse(
            readFileSync(resolve(parsed.values['source-criteria']), 'utf8'),
          ) as PullRequestSourceCriteriaBinding,
        }),
    waitMinutes: Number(parsed.values['wait-minutes'] ?? '10'),
  };
  validatePrepare(options);
  let result: PrepareResult;
  try {
    result = await prepare(
      options,
      dependencies?.prepare ?? (await productionDependencies(configPath, worktree)),
    );
  } catch (error) {
    // A git, Linear, lease, authority or evidence condition is a refusal (exit 1), not misuse.
    if (
      error instanceof UsageError ||
      error instanceof ExecutionStateError ||
      error instanceof EvidenceRequestError ||
      error instanceof CiEvidenceError ||
      error instanceof LinearError
    )
      return {
        code: 1,
        output: json
          ? JSON.stringify({ ok: false, error: error.message })
          : `REFUSED: ${error.message}`,
      };
    throw error;
  }
  return {
    code: 0,
    output: json
      ? JSON.stringify(result)
      : [
          `file ${result.file}`,
          `digest ${result.digest}`,
          `run ${result.runId} (${result.dispatched ? 'dispatched' : 'reused'})`,
          `route ${result.route}; operation ${result.operationId}; runner ${result.environment}`,
        ].join('\n'),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
