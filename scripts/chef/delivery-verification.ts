import { hostname } from 'node:os';
import { join } from 'node:path';
import { createGitHubCiEvidenceProvider } from './ci-evidence-github.ts';
import { ciEvidenceRequestKey, type CiEvidenceProvider } from './ci-evidence.ts';
import {
  batchVerificationPlanDigest,
  collectCompletionRecords,
  readDeliveryRequest,
  type DeliveryRequest,
} from './delivery-completion.ts';
import type { ProviderEvidenceTransport } from './evidence-transport.ts';
import {
  createExecutionStateStore,
  readExecutionSnapshot,
  recordMutationResult,
  registerDeliveryApproval,
  requireAuthority,
  withProviderTransitionLock,
  type ExecutionStateStore,
} from './execution-state.ts';
import { resolveMainCheckout } from './repository-locations.ts';
import { digest, gateAssignment, type Assignment } from './verification-plan.ts';

/** Coordinator-pinned input required before either delivery route can mutate a provider. */
export interface DeliveryVerification {
  file: string;
  digest: string;
  stateDirectory?: string | undefined;
}

export interface LoadedDeliveryVerification {
  request: DeliveryRequest;
  file: string;
  digest: string;
  state: ExecutionStateStore;
}

/** Production defaults authenticate provider facts; callers may inject only those raw dependencies. */
export interface DeliveryVerificationDependencies {
  state: ExecutionStateStore;
  transport?: ProviderEvidenceTransport;
  ciProvider?: Pick<CiEvidenceProvider, 'findRuns'>;
}

export interface DeliveryRoute {
  route: string;
  action: string;
}

/** The durable, provider-observed identity of one delivery merge. */
export interface DeliveryMergeObservation {
  route: 'branch' | 'pull-request';
  reviewedHead: string;
  base: string;
  integrationTree: string;
  /**
   * When `main` moved after the evidence and the landing queue verified that its new commits touch
   * nothing the evidence covers (`direct-merge.ts`), `base` and `integrationTree` stay the
   * attested ones, and these name the base and tree actually pushed.
   */
  landedBase?: string;
  landedTree?: string;
  mergeCommit?: string;
  state: 'pending-provider-outcome' | 'confirmed-merge';
  branch?: string;
  pullRequest?: number;
}

/** Every issue-only member remains held through prepare, check, and landing. */
function requireDeliveryAuthorities(state: ExecutionStateStore, request: DeliveryRequest): void {
  requireAuthority(state, request.authority);
  for (const member of request.members) {
    if (member.authority !== undefined) requireAuthority(state, member.authority);
  }
}

/** Holds every approved authority in a stable order for one consequential provider transition. */
export async function withDeliveryAuthorityFences<T>(
  state: ExecutionStateStore,
  request: DeliveryRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const authorities = [
    request.authority,
    ...request.members.flatMap((member) => member.authority ?? []),
  ];
  const ordered = [
    ...new Map(authorities.map((authority) => [authority.resource, authority])).values(),
  ].toSorted((left, right) => left.resource.localeCompare(right.resource));
  const enter = async (index: number): Promise<T> => {
    if (index === ordered.length) return operation();
    const authority = ordered[index];
    if (authority === undefined) throw new Error('delivery authority fence is empty');
    return withProviderTransitionLock(state, authority.resource, async () => {
      requireAuthority(state, authority);
      return enter(index + 1);
    });
  };
  return enter(0);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

export function isDeliveryMergeObservation(value: unknown): value is DeliveryMergeObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const observation = value as Partial<DeliveryMergeObservation>;
  try {
    validateDeliveryMergeObservation(observation as DeliveryMergeObservation, {
      revision: observation.reviewedHead ?? '',
      base: observation.base ?? '',
      integrationTree: observation.integrationTree ?? '',
    });
    return true;
  } catch {
    return false;
  }
}

/** Refuses malformed provider observations before their durable persistence. */
export function validateDeliveryMergeObservation(
  value: DeliveryMergeObservation,
  request: Pick<DeliveryRequest, 'revision' | 'base' | 'integrationTree'>,
): void {
  if (
    (value.route !== 'branch' && value.route !== 'pull-request') ||
    !isCommit(value.reviewedHead) ||
    !isCommit(value.base) ||
    !isCommit(value.integrationTree) ||
    value.reviewedHead !== request.revision ||
    value.base !== request.base ||
    value.integrationTree !== request.integrationTree ||
    (value.state !== 'pending-provider-outcome' && value.state !== 'confirmed-merge') ||
    (value.state === 'confirmed-merge' && !isCommit(value.mergeCommit)) ||
    (value.mergeCommit !== undefined && !isCommit(value.mergeCommit)) ||
    (value.route === 'branch' && (typeof value.branch !== 'string' || value.branch === '')) ||
    (value.route === 'pull-request' &&
      (value.pullRequest === undefined ||
        !Number.isSafeInteger(value.pullRequest) ||
        value.pullRequest < 1))
  )
    throw new Error('delivery merge observation does not match the original request identity');
}

/** Persist a validated merge receipt, retaining the original authority and operation identity. */
export async function recordDeliveryMergeObservation(
  verification: LoadedDeliveryVerification,
  observation: DeliveryMergeObservation,
  outcome: 'observed' | 'unknown' | 'unresolved',
  partial: Partial<DeliveryVerificationDependencies> = {},
): Promise<void> {
  validateDeliveryMergeObservation(observation, verification.request);
  const state = partial.state ?? verification.state;
  requireDeliveryAuthorities(state, verification.request);
  await recordMutationResult(
    state,
    verification.request.authority,
    verification.request.operationId,
    {
      outcome,
      observed: observation,
    },
  );
}

/**
 * Records the coordinator's accepted contract on the original operation before a delivery route
 * starts. This is intentionally separate from route execution: a request cannot approve itself.
 */
export async function prepareDeliveryVerification(
  verification: DeliveryVerification,
  assignments: Assignment[],
  route: DeliveryRoute,
  partial: Partial<DeliveryVerificationDependencies> = {},
): Promise<void> {
  const request = readDeliveryRequest(verification.file, verification.digest);
  const state = deliveryState(verification, partial);
  requireDeliveryAuthorities(state, request);
  const approvedAssignments = structuredClone(assignments);
  if (approvedAssignments.length !== request.members.length)
    throw new Error('delivery approval does not match its accepted members');
  for (const [index, member] of request.members.entries()) {
    const assignment = approvedAssignments[index];
    if (
      assignment === undefined ||
      !gateAssignment(assignment, 'held').dispatchable ||
      JSON.stringify(assignment) !== JSON.stringify(member.assignment)
    )
      throw new Error('delivery approval has an unaccepted assignment');
    if (!assignment.allowedConsequentialActions.includes(route.action))
      throw new Error(`delivery approval does not permit ${route.action}`);
  }
  await registerDeliveryApproval(state, request.authority, request.operationId, {
    members: request.members.map((member) => ({
      identifier: member.assignment.identity.identifier,
      assignmentDigest: member.assignment.identity.digest,
      planDigest: digest(JSON.stringify(member.plan)),
    })),
    requestDigest: verification.digest,
    repository: request.repository,
    revision: request.revision,
    base: request.base,
    integrationTree: request.integrationTree,
    route: route.route,
    action: route.action,
  });
}

function deliveryState(
  verification: DeliveryVerification,
  partial: Partial<DeliveryVerificationDependencies>,
): ExecutionStateStore {
  return (
    partial.state ??
    createExecutionStateStore({
      stateDirectory:
        verification.stateDirectory ??
        join(resolveMainCheckout(), 'tmp', 'chef', 'execution-state'),
      hostId: hostname(),
    })
  );
}

/** Validates untrusted file shape, digest and the originally acquired authority before Git/provider work. */
export function loadDeliveryVerification(
  verification: DeliveryVerification,
  partial: Partial<DeliveryVerificationDependencies> = {},
): LoadedDeliveryVerification {
  const request = readDeliveryRequest(verification.file, verification.digest);
  const state = deliveryState(verification, partial);
  requireDeliveryAuthorities(state, request);
  return { request, file: verification.file, digest: verification.digest, state };
}

/** Recovery authenticates original approval without requiring an already merged base to stay current. */
export function validateDeliveryApproval(
  verification: LoadedDeliveryVerification,
  expected: DeliveryRoute,
  partial: Partial<DeliveryVerificationDependencies> = {},
): string | undefined {
  const { request } = verification;
  const state = partial.state ?? verification.state;
  requireDeliveryAuthorities(state, request);
  const operation = readExecutionSnapshot(state).operations[request.operationId];
  const approval = operation?.approval;
  if (approval === undefined) return 'delivery request has no coordinator approval binding';
  const members = request.members.map((member) => ({
    identifier: member.assignment.identity.identifier,
    assignmentDigest: member.assignment.identity.digest,
    planDigest: digest(JSON.stringify(member.plan)),
  }));
  if (
    operation?.action !== expected.action ||
    approval.action !== expected.action ||
    approval.route !== expected.route ||
    JSON.stringify(approval.members) !== JSON.stringify(members) ||
    approval.requestDigest !== verification.digest ||
    approval.repository !== request.repository ||
    approval.revision !== request.revision ||
    approval.base !== request.base ||
    approval.integrationTree !== request.integrationTree
  )
    return 'delivery request does not match its coordinator approval binding';
  return undefined;
}

/** Authenticated evidence is re-collected only after current Git identity is known. */
export function validateDeliveryVerification(
  verification: LoadedDeliveryVerification,
  expected: {
    repository: string;
    revision: string;
    base: string;
    integrationTree: string;
  } & DeliveryRoute,
  partial: Partial<DeliveryVerificationDependencies> = {},
): string | undefined {
  const problem = validateDeliveryApproval(verification, expected, partial);
  if (problem !== undefined) return problem;
  const { request } = verification;
  if (request.repository !== expected.repository)
    return 'verification request names another repository';
  if (request.revision !== expected.revision)
    return 'verification request has a stale reviewed head';
  if (request.base !== expected.base) return 'verification request has a stale base';
  if (request.integrationTree !== expected.integrationTree)
    return 'verification request has a stale expected integration tree';
  const records = collectCompletionRecords(request, 'pre-integration', partial.transport);
  const problems = records.flatMap((record) =>
    record.remainingGates.map((gate) => `${record.identifier}: ${gate}`),
  );
  return problems.length === 0 ? undefined : problems.join('; ');
}

const aggregatedWorkflows = new Set([
  '.github/workflows/main.yml',
  '.github/workflows/pull-request.yml',
]);
const pullRequestReceiptJobs = ['static', 'workspaces', 'tests', 'browser-selection', 'browser'];

function hasCompletePullRequestCoverage(
  member: DeliveryRequest['members'][number],
  run: Awaited<ReturnType<CiEvidenceProvider['findRuns']>>[number],
  sourceCriteria: CiEvidenceRequest['sourceCriteria'],
): boolean {
  if (run === undefined || 'state' in run || !run.jobs.includes('Evidence aggregate')) return false;
  if (
    Object.keys(run.receiptJobs).length !== pullRequestReceiptJobs.length ||
    pullRequestReceiptJobs.some((job) =>
      job === 'browser'
        ? !['success', 'not-applicable'].includes(run.receiptJobs[job] ?? '')
        : run.receiptJobs[job] !== 'success',
    )
  )
    return false;
  const browserRequired = member.plan.obligations.some((item) =>
    item.relevantInputs.some(
      (path) =>
        path.startsWith('scripts/browser-fixtures/') ||
        path.startsWith('applications/interborough/'),
    ),
  );
  if (browserRequired) return false;
  if (sourceCriteria === undefined || run.receiptTestFiles === undefined) return false;
  const binding = sourceCriteria.members.find(
    (candidate) => candidate.identifier === member.assignment.identity.identifier,
  );
  if (binding === undefined) return false;
  const criteria =
    member.assignment.criteria.length === 0 && member.assignment.classification === 'no-behavior'
      ? ['STATIC']
      : member.assignment.criteria.map((criterion) => criterion.id);
  if (
    binding.criteria.length !== criteria.length ||
    binding.criteria.some(
      (criterion) =>
        !criteria.includes(criterion.criterionId) ||
        criterion.testFiles.some((path) => !run.receiptTestFiles?.includes(path)),
    )
  )
    return false;
  return true;
}

/** Require a current authenticated aggregate for the CI runs that carry pre-merge obligations. */
export async function validateDeliveryCiEvidence(
  verification: LoadedDeliveryVerification,
  partial: Partial<DeliveryVerificationDependencies> = {},
): Promise<string | undefined> {
  const { request } = verification;
  const mappings = request.members.flatMap((member) => {
    const obligations = new Set(
      member.plan.obligations
        .filter((item) => item.phase === 'pre-integration')
        .map((item) => `${item.criterionId}:${item.commandOrProviderJob}`),
    );
    return member.providerRuns
      .filter((run) => obligations.has(run.obligation) && aggregatedWorkflows.has(run.workflowPath))
      .map((run) => ({ member, run }));
  });
  if (mappings.length === 0) return undefined;
  if (!Array.isArray(request.ciEvidence))
    return 'verification request is missing the CI evidence contract';
  const manualPlanDigest = batchVerificationPlanDigest(request.members);
  const source =
    partial.ciProvider ??
    createGitHubCiEvidenceProvider({
      repository: request.repository,
      cwd: request.worktree,
    });
  const observed = new Map<string, Awaited<ReturnType<typeof source.findRuns>>>();
  for (const mapping of mappings) {
    const matches = request.ciEvidence.filter(
      (identity) =>
        identity?.repository === request.repository &&
        identity.candidate === request.revision &&
        identity.base === request.base &&
        identity.integrationTree === request.integrationTree &&
        identity.event === mapping.run.event &&
        (mapping.run.event !== 'workflow_dispatch' ||
          identity.verificationPlanDigest === manualPlanDigest) &&
        identity.workflow === mapping.run.workflow &&
        identity.workflowPath === mapping.run.workflowPath &&
        identity.requestKey === ciEvidenceRequestKey(identity),
    );
    const identity = matches[0];
    if (identity === undefined || matches.length !== 1)
      return 'verification request has missing or ambiguous CI evidence identity';
    let runs = observed.get(identity.requestKey);
    if (runs === undefined) {
      try {
        runs = await source.findRuns(identity);
      } catch {
        return `CI evidence for run ${mapping.run.id} is unavailable`;
      }
      observed.set(identity.requestKey, runs);
    }
    const run = runs[0];
    if (
      runs.length !== 1 ||
      run === undefined ||
      'state' in run ||
      run.id !== mapping.run.id ||
      run.requestKey !== identity.requestKey ||
      !run.jobs.includes(mapping.run.job) ||
      (mapping.run.event === 'pull_request' &&
        !hasCompletePullRequestCoverage(mapping.member, run, identity.sourceCriteria))
    )
      return `CI evidence for run ${mapping.run.id} is missing its successful aggregate or required job`;
  }
  return undefined;
}
