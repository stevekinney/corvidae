import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  collectProviderEvidence,
  createGitHubEvidenceTransport,
  EvidenceRequestError,
  validateEvidence,
  validateEvidenceObligations,
  validateVerificationRequest,
  type EvidenceRecord,
  type ProviderEvidenceTransport,
  type VerificationRequest,
} from './evidence.ts';
import {
  digest,
  gateAssignment,
  type Assignment,
  type VerificationPlan,
} from './verification-plan.ts';

export interface DeliveryPlan extends Omit<VerificationPlan, 'obligations'> {
  obligations: (VerificationPlan['obligations'][number] & {
    phase: 'pre-integration' | 'completion';
  })[];
}

/** Each member retains its own criterion namespace and independently approved evidence plan. */
export interface DeliveryMember {
  assignment: Assignment;
  plan: DeliveryPlan;
  providerRuns: VerificationRequest['providerRuns'];
  track: boolean;
  requestedClose: boolean;
  changes: string[];
  blockers: string[];
}

/** A batch composes the existing single-assignment collector; it does not trust worker verdicts. */
export interface DeliveryRequest extends Omit<
  VerificationRequest,
  'plan' | 'providerRuns' | 'localRuns'
> {
  worktree: string;
  members: DeliveryMember[];
}

export interface CompletionRecord {
  operationId: string;
  runId: string;
  ownerId: string;
  generation: number;
  identifier: string;
  assignmentDigest: string;
  planDigest: string;
  revision: string;
  integrationTree: string;
  requirements: Assignment['criteria'];
  records: EvidenceRecord[];
  requestedClose: boolean;
  track: boolean;
  eligible: boolean;
  remainingGates: string[];
  changes: string[];
  blockers: string[];
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');

/** Parse a digest-pinned contract before provider reads; its fields request proof, never supply it. */
export function readDeliveryRequest(file: string, expectedDigest: string): DeliveryRequest {
  if (!/^[0-9a-f]{64}$/.test(expectedDigest))
    throw new EvidenceRequestError('delivery digest is not SHA-256');
  const text = readFileSync(file, 'utf8');
  if (digest(text) !== expectedDigest)
    throw new EvidenceRequestError('delivery file digest does not match');
  const value: unknown = JSON.parse(text);
  if (!plain(value) || !Array.isArray(value['members']) || value['members'].length === 0)
    throw new EvidenceRequestError('delivery request needs a nonempty member list');
  for (const field of ['revision', 'base', 'integrationTree'])
    if (typeof value[field] !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value[field]))
      throw new EvidenceRequestError(`delivery request has invalid ${field}`);
  if (
    typeof value['repository'] !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value['repository']) ||
    typeof value['environment'] !== 'string' ||
    value['environment'].trim() === '' ||
    typeof value['operationId'] !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value['operationId'])
  )
    throw new EvidenceRequestError('delivery request has invalid identity');
  const authority = value['authority'];
  if (
    !plain(authority) ||
    !['runId', 'ownerId', 'resource'].every(
      (key) => typeof authority[key] === 'string' && authority[key].trim() !== '',
    ) ||
    !Number.isSafeInteger(authority['generation']) ||
    Number(authority['generation']) < 1
  )
    throw new EvidenceRequestError('delivery request has invalid authority');
  const request = value as unknown as DeliveryRequest;
  if (
    typeof request.worktree !== 'string' ||
    !isAbsolute(request.worktree) ||
    request.worktree.includes('\0')
  )
    throw new EvidenceRequestError('delivery request has invalid owned worktree');
  const identifiers = new Set<string>();
  for (const member of request.members) {
    if (
      !plain(member) ||
      !plain(member.assignment) ||
      !gateAssignment(member.assignment, 'held').dispatchable ||
      !plain(member.plan) ||
      !Array.isArray(member.plan.obligations) ||
      !plain(member.plan.invalidatedBy) ||
      !Array.isArray(member.providerRuns) ||
      typeof member.track !== 'boolean' ||
      typeof member.requestedClose !== 'boolean' ||
      !strings(member.changes) ||
      !strings(member.blockers)
    )
      throw new EvidenceRequestError('delivery request has malformed member');
    const { identity, criteria } = member.assignment;
    if (
      (member.requestedClose && !member.track) ||
      (member.track && !/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(identity.identifier))
    )
      throw new EvidenceRequestError('delivery member has invalid tracking intent');
    if (
      identifiers.has(identity.identifier) ||
      identity.repository !== request.repository ||
      identity.base !== request.base ||
      identity.digest !== member.plan.invalidatedBy.assignment
    )
      throw new EvidenceRequestError(
        'delivery member has duplicate or mismatched assignment identity',
      );
    identifiers.add(identity.identifier);
    if (
      member.plan.obligations.some(
        (obligation) =>
          !['pre-integration', 'completion'].includes(obligation.phase) ||
          !(
            criteria.some((criterion) => criterion.id === obligation.criterionId) ||
            (member.assignment.classification === 'no-behavior' &&
              criteria.length === 0 &&
              obligation.criterionId === 'STATIC')
          ),
      )
    )
      throw new EvidenceRequestError('delivery member has an unbound criterion or phase');
    if (
      member.assignment.classification === 'behavior' &&
      (criteria.length === 0 ||
        criteria.some(
          (criterion) =>
            !member.plan.obligations.some((obligation) => obligation.criterionId === criterion.id),
        ))
    )
      throw new EvidenceRequestError('delivery member has unverified acceptance criteria');
    validateEvidenceObligations(member.plan);
    const mapped = new Set(member.providerRuns.map((run) => run.obligation));
    validateVerificationRequest({
      ...request,
      plan: {
        ...member.plan,
        obligations: member.plan.obligations.filter((item) =>
          mapped.has(`${item.criterionId}:${item.commandOrProviderJob}`),
        ),
      },
      providerRuns: member.providerRuns,
    });
  }
  return request;
}

/** Validate each member separately, so equal criterion names cannot borrow another member's proof. */
export function collectCompletionRecords(
  request: DeliveryRequest,
  phase: 'pre-integration' | 'completion',
  transport: ProviderEvidenceTransport = createGitHubEvidenceTransport(request.repository),
): CompletionRecord[] {
  return request.members.map((member) => {
    const obligations = member.plan.obligations.filter(
      (item) => phase === 'completion' || item.phase === phase,
    );
    const keys = new Set(
      obligations.map((item) => `${item.criterionId}:${item.commandOrProviderJob}`),
    );
    const providerRuns = member.providerRuns.filter((run) => keys.has(run.obligation));
    // Missing completion jobs are unmet obligations, not permission to close or to invent a run.
    const mapped = new Set(providerRuns.map((run) => run.obligation));
    const collection = collectProviderEvidence(
      {
        repository: request.repository,
        revision: request.revision,
        base: request.base,
        integrationTree: request.integrationTree,
        environment: request.environment,
        authority: request.authority,
        operationId: request.operationId,
        plan: {
          ...member.plan,
          obligations: obligations.filter((item) =>
            mapped.has(`${item.criterionId}:${item.commandOrProviderJob}`),
          ),
        },
        providerRuns,
      },
      transport,
    );
    const validation = validateEvidence({ ...member.plan, obligations }, collection, request);
    const remainingGates = validation.problems;
    return {
      operationId: request.operationId,
      runId: request.authority.runId,
      ownerId: request.authority.ownerId,
      generation: request.authority.generation,
      identifier: member.assignment.identity.identifier,
      assignmentDigest: member.assignment.identity.digest,
      planDigest: digest(JSON.stringify(member.plan)),
      revision: request.revision,
      integrationTree: request.integrationTree,
      requirements: member.assignment.criteria,
      records: validation.records,
      requestedClose: member.requestedClose,
      track: member.track,
      eligible: phase === 'completion' && validation.ok && member.blockers.length === 0,
      remainingGates,
      changes: member.changes,
      blockers: member.blockers,
    };
  });
}

/** Markdown is a view of collected facts and remaining obligations, never an acceptance input. */
export function renderMemberCompletion(record: CompletionRecord, mergeCommit: string): string {
  const lines = (items: string[]) => items.map((item) => `- ${item}`).join('\n') || '- None.';
  return [
    `Execution report: ${record.identifier} operation ${record.operationId}`,
    '',
    '## Execution status',
    record.eligible
      ? 'Verified for the requested completion boundary.'
      : 'Merged; acceptance obligations remain.',
    '',
    '## Agent and session',
    `Run ${record.runId}; owner ${record.ownerId}; generation ${record.generation}.`,
    '',
    '## Attempt',
    `Original operation: ${record.operationId}.`,
    '',
    '## Branch and pull request',
    `Reviewed revision: ${record.revision}. Merge commit: ${mergeCommit}.`,
    '',
    '## Requirements implemented',
    lines(record.requirements.map(({ id, text }) => `${id}: ${text}`)),
    '',
    '## Acceptance criteria',
    `Assignment digest: ${record.assignmentDigest}. Plan digest: ${record.planDigest}.`,
    `Requested close: ${record.requestedClose}. Eligible to close: ${record.eligible}.`,
    '',
    '## Verification',
    lines(
      record.records.map(
        (item) =>
          `${item.obligation}: ${item.status}; ${item.command}; exit ${item.exitCode}; inventory ${item.inventory.length}.`,
      ),
    ),
    '',
    '## Changes',
    lines(record.changes),
    '',
    '## Blockers and open questions',
    lines(record.blockers),
    '',
    '## Remaining work',
    lines(record.remainingGates),
  ].join('\n');
}
