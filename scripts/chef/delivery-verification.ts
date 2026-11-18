import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ProviderEvidenceTransport } from './evidence-transport.ts';
import {
  collectProviderEvidenceFromRequest,
  readVerificationRequest,
  validateEvidence,
  type VerificationRequest,
} from './evidence.ts';
import {
  createExecutionStateStore,
  readExecutionSnapshot,
  registerDeliveryApproval,
  requireAuthority,
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
  request: VerificationRequest;
  file: string;
  digest: string;
  state: ExecutionStateStore;
}

/** Production defaults authenticate provider facts; callers may inject only those raw dependencies. */
export interface DeliveryVerificationDependencies {
  state: ExecutionStateStore;
  transport?: ProviderEvidenceTransport;
}

export interface DeliveryRoute {
  route: string;
  action: string;
}

/**
 * Records the coordinator's accepted contract on the original operation before a delivery route
 * starts. This is intentionally separate from route execution: a request cannot approve itself.
 */
export async function prepareDeliveryVerification(
  verification: DeliveryVerification,
  assignment: Assignment,
  route: DeliveryRoute,
  partial: Partial<DeliveryVerificationDependencies> = {},
): Promise<void> {
  const request = readVerificationRequest(verification.file, verification.digest);
  const state = deliveryState(verification, partial);
  requireAuthority(state, request.authority);
  if (!gateAssignment(assignment, 'held').dispatchable)
    throw new Error('delivery approval has an unaccepted assignment');
  if (!assignment.allowedConsequentialActions.includes(route.action))
    throw new Error(`delivery approval does not permit ${route.action}`);
  if (
    assignment.identity.repository !== request.repository ||
    assignment.identity.base !== request.base ||
    assignment.identity.digest !== request.plan.invalidatedBy.assignment
  )
    throw new Error('delivery approval does not match the accepted assignment');
  if (request.plan.obligations.length === 0 && assignment.classification !== 'no-behavior')
    throw new Error('behavior delivery approval has no verification obligations');
  await registerDeliveryApproval(state, request.authority, request.operationId, {
    assignment: { identifier: assignment.identity.identifier, digest: assignment.identity.digest },
    planDigest: digest(JSON.stringify(request.plan)),
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
  const request = readVerificationRequest(verification.file, verification.digest);
  const state = deliveryState(verification, partial);
  requireAuthority(state, request.authority);
  return { request, file: verification.file, digest: verification.digest, state };
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
  const { request } = verification;
  const state = partial.state ?? verification.state;
  requireAuthority(state, request.authority);
  const operation = readExecutionSnapshot(state).operations[request.operationId];
  const approval = operation?.approval;
  if (approval === undefined) return 'delivery request has no coordinator approval binding';
  if (
    operation?.action !== expected.action ||
    approval.action !== expected.action ||
    approval.route !== expected.route ||
    approval.assignment.digest !== request.plan.invalidatedBy.assignment ||
    approval.requestDigest !== verification.digest ||
    approval.planDigest !== digest(JSON.stringify(request.plan)) ||
    approval.repository !== request.repository ||
    approval.revision !== request.revision ||
    approval.base !== request.base ||
    approval.integrationTree !== request.integrationTree
  )
    return 'delivery request does not match its coordinator approval binding';
  if (request.repository !== expected.repository)
    return 'verification request names another repository';
  if (request.revision !== expected.revision)
    return 'verification request has a stale reviewed head';
  if (request.base !== expected.base) return 'verification request has a stale base';
  if (request.integrationTree !== expected.integrationTree)
    return 'verification request has a stale expected integration tree';
  const result = validateEvidence(
    request.plan,
    collectProviderEvidenceFromRequest(verification.file, verification.digest, partial.transport),
    {
      revision: expected.revision,
      integrationTree: expected.integrationTree,
      environment: request.environment,
    },
  );
  return result.ok ? undefined : result.problems.join('; ');
}
