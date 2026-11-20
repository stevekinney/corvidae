#!/usr/bin/env bun
// Chef delivery request: the writer and the dry check of the request `deliver.ts` lands from, so a
// batch dispatched by hand reaches `deliver.ts --branch|--pr` without a hand-built JSON file.
//
// Usage:
//   bun scripts/chef/delivery-request.ts prepare --branch <branch> --head <sha> --worktree <path>
//       --base <sha> --run <id> --project <name> --issue <ID> [--issue <ID> ...]
//       [--route branch|pull-request] [--no-track] [--no-close] [--leave-open <ID> ...]
//       [--classification behavior|no-behavior] [--wait-minutes <n>] [--config <file>] [--json]
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
//      source digests exist only on that read. The coordinator adds `merge` to each assignment's
//      consequential actions (the acceptance this command records) and re-digests it.
//   2. The evidence plan is computed from `git diff <base>...<head>` (`computeEvidencePlan`). Every
//      acceptance criterion of every member becomes one provider obligation on one `main.yml` job
//      (`Root checks, scripts tests, audit`, `EVIDENCE_JOB`), phase `pre-integration`. What the run
//      proves is the whole green `main.yml` run on the head, bound by an evidence identity; what the
//      coordinator attests is that each criterion was accepted. No criterion has a test of its own.
//   3. The identity, its request key and the batch plan digest are computed before anything is sent.
//      `targeted-run.ts` dispatches `main.yml` with `verification_request`, `verification_plan` and
//      `verification_base` (its one dispatch path) unless a run with that key already exists, so a
//      second `prepare` for the same head reuses the run. The run id and the runner of the evidence
//      job are known only afterwards, and both enter the digest-pinned file: `prepare` polls (up to
//      `--wait-minutes`, default 10) until the job has a runner. If that expires, run the same
//      command again; nothing is dispatched twice.
//   4. The branch must contain `--base`: a workflow dispatch checks out the branch head, so the
//      request's integration tree is the head's tree, and `deliver.ts` compares it with
//      `git merge-tree --write-tree <base> <head>`. After `prepare`, dispatch nothing else on the
//      branch: a newer dispatch on a ref cancels this run, and a red or cancelled bound run cannot
//      be replaced for the same head (a second run with the same key is ambiguous). Push a new head
//      and prepare again. The execution state's authority is the project lease's
//      (`project:<id>`, owner `linear:<run>`, from `linear.ts lease`); `prepare` never mints one.
//   Members are tracked and closed on delivery by default (`--no-track` tracks none, `--no-close`
//   closes none, `--leave-open <ID>` keeps one open). `--route` is the approval's route, `branch`
//   unless the head lands by pull request; one-way doors need `pull-request`.
//
// `check` runs what `deliver.ts` runs before it merges, without merging: it loads the request,
// derives the current base, head and integration tree from git (`git fetch origin <default>`;
// `--head`, else the worktree's HEAD), then `validateDeliveryVerification`,
// `validateDeliveryCiEvidence` and `validateLandingEvidence`, and prints each refusal. Run it from
// a checkout that has the head fetched. A base that has moved is refused even for a branch route,
// which `deliver.ts` accepts only when the new commits touch nothing the evidence covers: `check`
// is conservative. The lease and the pull-request threads are `deliver.ts`'s own steps.
//
// Exit codes: `prepare` 0 request written and run dispatched or reused; `check` 0 when `deliver.ts`
// would proceed past verification, 1 with a refusal printed; both 2 on invalid usage.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { readBatchBrief, refusalReasons } from './brief.ts';
import { createGitHubCiEvidenceProvider } from './ci-evidence-github.ts';
import {
  ciEvidenceRequestKey,
  type CiEvidenceProvider,
  type CiEvidenceRequest,
} from './ci-evidence.ts';
import {
  batchVerificationPlanDigest,
  readDeliveryRequest,
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
import {
  createExecutionStateStore,
  currentAuthority,
  readExecutionSnapshot,
  recordMutationIntent,
  type ExecutionStateStore,
} from './execution-state.ts';
import { validateLandingEvidence } from './landing-evidence.ts';
import { changedPaths } from './landing-plan.ts';
import { createClient, readProject } from './linear.ts';
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
import { dispatchVerificationRun, type VerificationBinding } from './targeted-run.ts';
import {
  computeEvidencePlan,
  createVerificationPlan,
  digest,
  gateAssignment,
  type Assignment,
  type EvidencePlan,
} from './verification-plan.ts';

export { UsageError };

/** The `main.yml` job every criterion's obligation names: it has no `needs`, so it starts first. */
export const EVIDENCE_JOB = 'Root checks, scripts tests, audit';
export const EVIDENCE_WORKFLOW = 'Main';
export const EVIDENCE_WORKFLOW_PATH = '.github/workflows/main.yml';

const ISSUE = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const POLL_INTERVAL_MILLISECONDS = 10_000;

export type DeliveryRoute = 'branch' | 'pull-request';

export interface PrepareOptions {
  branch: string;
  head: string;
  worktree: string;
  base: string;
  run: string;
  project: string;
  issues: string[];
  route: DeliveryRoute;
  track: boolean;
  close: boolean;
  leaveOpen: string[];
  classification?: 'behavior' | 'no-behavior' | undefined;
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
export interface RunJob {
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
  }) => Promise<{ assignments: Assignment[]; refusals: string[] }>;
  /** The execution-state resource of the project lease `run` holds, or a thrown reason. */
  leaseResource: (project: string, run: string) => Promise<string>;
  plan: (changed: string[], worktree: string) => EvidencePlan;
  provider: Pick<CiEvidenceProvider, 'findRuns'>;
  readJobs: (runId: number) => RunJob[];
  wait: (milliseconds: number) => Promise<void>;
  dispatch: (ref: string, binding: VerificationBinding, cwd: string) => string[];
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
): DeliveryMember[] {
  const reason = `main.yml job "${EVIDENCE_JOB}" of the run bound to this head; evidence plan: ${plan.changed.length} changed files, ${plan.unit_tests.length} unit-test lanes, full run ${plan.requires_full_run ? `required (${plan.full_run_rules.map(({ rule }) => rule).join('; ')})` : 'not required'}.`;
  return assignments.map((assignment) => {
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
      plan: {
        version: base.version,
        risks: base.risks,
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
  const kept = git(runner, cwd, [
    'diff',
    '--name-only',
    '--diff-filter=d',
    `${options.base}...${options.head}`,
  ])
    .split('\n')
    .filter((path) => path !== '');
  const plan = dependencies.plan(kept, cwd);

  const read = await dependencies.readAssignments({
    issues: options.issues,
    repository,
    base: options.base,
    run: options.run,
    classification: options.classification,
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
  if (accepted.map((assignment) => assignment.identity.identifier).join() !== options.issues.join())
    throw new UsageError('the assignments read do not match --issue, in order.');

  const resource = await dependencies.leaseResource(options.project, options.run);
  const authority = currentAuthority(dependencies.state, {
    resource,
    runId: options.run,
    ownerId: `linear:${options.run}`,
  });

  const members = membersOf(accepted, options, plan, plan.changed);
  const identityInput = {
    repository,
    resource: authority.resource,
    base: options.base,
    candidate: options.head,
    integrationTree,
    verificationPlanDigest: batchVerificationPlanDigest(members),
    workflow: EVIDENCE_WORKFLOW,
    workflowPath: EVIDENCE_WORKFLOW_PATH,
    workflowRevision: options.head,
    event: 'workflow_dispatch',
  } satisfies Omit<CiEvidenceRequest, 'requestKey'>;
  const identity: CiEvidenceRequest = {
    ...identityInput,
    requestKey: ciEvidenceRequestKey(identityInput),
  };
  const attempts = Math.ceil((options.waitMinutes * 60_000) / POLL_INTERVAL_MILLISECONDS);

  const found = await dependencies.provider.findRuns(identity);
  if (found.length > 1)
    throw new UsageError(
      `${found.length} runs carry request key ${identity.requestKey}: a second dispatch for this head cannot be told from the first; push a new head.`,
    );
  let dispatched = false;
  let command: string[] = [];
  if (found.length === 0) {
    command = dependencies.dispatch(
      options.branch,
      { request: identity.requestKey, plan: identity.verificationPlanDigest, base: options.base },
      cwd,
    );
    dispatched = true;
  }
  const observed = await poll(attempts, dependencies, async () => {
    try {
      const runs = await dependencies.provider.findRuns(identity);
      return runs.length === 1 ? runs[0] : undefined;
    } catch {
      return undefined;
    }
  });
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
      .find((candidate) => candidate.name === EVIDENCE_JOB && candidate.runner !== ''),
  );
  if (job === undefined)
    throw new UsageError(
      `run ${runId}'s job "${EVIDENCE_JOB}" has no runner yet; run the same command again (it dispatches nothing twice).`,
    );

  const finished: DeliveryMember[] = members.map((member) => ({
    ...member,
    providerRuns: member.plan.obligations.map((obligation) => ({
      id: runId,
      obligation: `${obligation.criterionId}:${obligation.commandOrProviderJob}`,
      job: EVIDENCE_JOB,
      workflow: EVIDENCE_WORKFLOW,
      workflowPath: EVIDENCE_WORKFLOW_PATH,
      event: 'workflow_dispatch',
    })),
  }));
  const operationId = operationIdOf(options.branch, options.head);
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
  const directory = join(dependencies.mainCheckout, 'tmp', 'chef', 'requests');
  mkdirSync(directory, { recursive: true });
  const file = join(
    directory,
    `${operationId.replaceAll(':', '-')}-${requestDigest.slice(0, 12)}.json`,
  );
  const staged = `${file}.${crypto.randomUUID()}`;
  writeFileSync(staged, text);
  renameSync(staged, file);
  readDeliveryRequest(file, requestDigest);

  const binding = {
    file,
    digest: requestDigest,
    stateDirectory: dependencies.state.stateDirectory,
  };
  await recordMutationIntent(dependencies.state, authority, {
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
  const operation = readExecutionSnapshot(loaded.state).operations[request.operationId];
  const route = operation?.approval?.route;
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
  const verification = validateDeliveryVerification(
    loaded,
    {
      repository: request.repository,
      revision: head,
      base,
      integrationTree,
      route,
      action: 'merge',
    },
    dependencies.verification,
  );
  if (verification !== undefined) problems.push(verification);
  const ci = await validateDeliveryCiEvidence(loaded, dependencies.verification);
  if (ci !== undefined) problems.push(ci);
  const landing = await validateLandingEvidence(
    loaded,
    { route, defaultBranch },
    {
      runner,
      ...(dependencies.verification.ciProvider === undefined
        ? {}
        : { ciProvider: dependencies.verification.ciProvider }),
      ...(dependencies.readVerdicts === undefined
        ? {}
        : { readVerdicts: dependencies.readVerdicts }),
    },
  );
  if (landing !== undefined) problems.push(landing);
  return problems;
}

/** The header's usage block. */
export function usageText(): string {
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
    leaseResource: async (project, run) => {
      const { data } = await readProject(client, project);
      const lease = data['lease'] as { run: string; live: boolean } | null;
      if (lease === null || lease.run !== run || !lease.live)
        throw new UsageError(
          `run ${run} does not hold a live lease on ${project}: run linear.ts lease first.`,
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
    const verification: Partial<DeliveryVerificationDependencies> = {
      ...(stateDirectory === undefined
        ? {}
        : {
            state: createExecutionStateStore({ stateDirectory, hostId: hostname() }),
          }),
    };
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
    project: requireOption(parsed, 'project'),
    issues: parsed.repeated['issue'] ?? [],
    route,
    track: !parsed.flags.has('no-track'),
    close: !parsed.flags.has('no-close') && !parsed.flags.has('no-track'),
    leaveOpen: parsed.repeated['leave-open'] ?? [],
    classification,
    waitMinutes: Number(parsed.values['wait-minutes'] ?? '10'),
  };
  validatePrepare(options);
  const result = await prepare(
    options,
    dependencies?.prepare ?? (await productionDependencies(configPath, worktree)),
  );
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
