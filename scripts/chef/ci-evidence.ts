import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateEvidence, type CollectedEvidence, type EvidenceExpectation } from './evidence.ts';
import { withProviderTransitionLock, type ExecutionStateStore } from './execution-state.ts';
import type { VerificationPlan } from './verification-plan.ts';

export class CiEvidenceError extends Error {}

export interface CiEvidenceStore extends ExecutionStateStore {
  requestPath: string;
}

export interface CiEvidenceRequest {
  repository: string;
  resource: string;
  base: string;
  candidate: string;
  integrationTree: string;
  verificationPlanDigest: string;
  workflow: string;
  workflowPath: string;
  workflowRevision: string;
  event: 'pull_request' | 'workflow_dispatch' | 'push';
  requestKey: string;
}

export interface CiEvidenceRun {
  id: number;
  repository: string;
  head: string;
  base: string;
  integrationTree: string;
  event: string;
  workflow: string;
  workflowPath: string;
  workflowRevision: string;
  verificationPlanDigest: string;
  requestKey: string;
  attempt: number;
  jobs: string[];
}

export interface CiEvidenceProvider {
  findRuns(request: CiEvidenceRequest): Promise<CiEvidenceRun[]>;
  dispatch(request: CiEvidenceRequest): Promise<void>;
}

interface StoredRequest {
  request: CiEvidenceRequest;
  dispatchAttempted: boolean;
  state: 'intent' | 'unresolved' | 'bound' | 'ambiguous';
  runs: CiEvidenceRun[];
}

interface CiEvidenceSnapshot {
  version: 1;
  requests: Record<string, StoredRequest>;
}

const commit = (value: string) => /^[0-9a-f]{40}$/.test(value);
const digest = (value: string) => /^[0-9a-f]{64}$/.test(value);
const text = (value: string) => value.trim() !== '' && !value.includes('\0');

function canonicalRequest(input: Omit<CiEvidenceRequest, 'requestKey'>): string {
  return JSON.stringify({
    repository: input.repository,
    base: input.base,
    candidate: input.candidate,
    integrationTree: input.integrationTree,
    verificationPlanDigest: input.verificationPlanDigest,
    workflow: input.workflow,
    workflowPath: input.workflowPath,
    workflowRevision: input.workflowRevision,
    event: input.event,
  });
}

/** The immutable request identity shared by dispatch, provider lookup, and durable recovery. */
export function ciEvidenceRequestKey(input: Omit<CiEvidenceRequest, 'requestKey'>): string {
  return createHash('sha256').update(canonicalRequest(input)).digest('hex');
}

export function createCiEvidenceStore(store: ExecutionStateStore): CiEvidenceStore {
  return { ...store, requestPath: join(store.stateDirectory, 'ci-evidence-requests.json') };
}

function validateRequest(request: CiEvidenceRequest): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
    !text(request.resource) ||
    !commit(request.base) ||
    !commit(request.candidate) ||
    !commit(request.integrationTree) ||
    !digest(request.verificationPlanDigest) ||
    !text(request.workflow) ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(request.workflowPath) ||
    !commit(request.workflowRevision) ||
    !['pull_request', 'workflow_dispatch', 'push'].includes(request.event) ||
    request.requestKey !== ciEvidenceRequestKey(request)
  )
    throw new CiEvidenceError('CI evidence request has invalid identity');
}

function emptySnapshot(): CiEvidenceSnapshot {
  return { version: 1, requests: Object.create(null) as Record<string, StoredRequest> };
}

function readSnapshot(store: CiEvidenceStore): CiEvidenceSnapshot {
  try {
    const parsed: unknown = JSON.parse(readFileSync(store.requestPath, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { requests?: unknown }).requests !== 'object' ||
      (parsed as { requests?: unknown }).requests === null
    )
      throw new CiEvidenceError('CI evidence state is malformed');
    return parsed as CiEvidenceSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
    if (error instanceof CiEvidenceError) throw error;
    throw new CiEvidenceError('CI evidence state is unreadable');
  }
}

function writeSnapshot(store: CiEvidenceStore, snapshot: CiEvidenceSnapshot): void {
  mkdirSync(store.stateDirectory, { recursive: true });
  const temporary = `${store.requestPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`);
    renameSync(temporary, store.requestPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function matches(request: CiEvidenceRequest, run: CiEvidenceRun): boolean {
  return (
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    run.repository === request.repository &&
    run.head === request.candidate &&
    run.base === request.base &&
    run.integrationTree === request.integrationTree &&
    run.event === request.event &&
    run.workflow === request.workflow &&
    run.workflowPath === request.workflowPath &&
    run.workflowRevision === request.workflowRevision &&
    run.verificationPlanDigest === request.verificationPlanDigest &&
    run.requestKey === request.requestKey &&
    Number.isSafeInteger(run.attempt) &&
    run.attempt >= 1 &&
    Array.isArray(run.jobs) &&
    run.jobs.length > 0 &&
    run.jobs.every(text)
  );
}

export type CiEvidenceReconciliation =
  | { state: 'bound'; requestKey: string; run: CiEvidenceRun }
  | { state: 'unresolved'; requestKey: string; runs: CiEvidenceRun[] }
  | { state: 'ambiguous'; requestKey: string; runs: CiEvidenceRun[] };

/**
 * Persist intent before dispatch. Once a request has been attempted, an absent or malformed
 * provider observation remains unresolved until an authenticated later read binds a single run.
 */
export async function reconcileCiEvidenceRequest(
  store: CiEvidenceStore,
  request: CiEvidenceRequest,
  provider: CiEvidenceProvider,
): Promise<CiEvidenceReconciliation> {
  validateRequest(request);
  return withProviderTransitionLock(store, `ci-evidence:${request.requestKey}`, async () => {
    const snapshot = readSnapshot(store);
    let record = snapshot.requests[request.requestKey];
    if (record === undefined) {
      record = { request, dispatchAttempted: false, state: 'intent', runs: [] };
      snapshot.requests[request.requestKey] = record;
      writeSnapshot(store, snapshot);
    } else if (JSON.stringify(record.request) !== JSON.stringify(request)) {
      throw new CiEvidenceError('CI evidence request key has conflicting durable intent');
    }

    if (record.state === 'bound' && record.runs.length === 1 && matches(request, record.runs[0]!))
      return { state: 'bound', requestKey: request.requestKey, run: record.runs[0]! };

    let observed: CiEvidenceRun[];
    try {
      observed = await provider.findRuns(request);
    } catch {
      record.state = 'unresolved';
      writeSnapshot(store, snapshot);
      return { state: 'unresolved', requestKey: request.requestKey, runs: record.runs };
    }
    if (!Array.isArray(observed))
      throw new CiEvidenceError('CI provider returned an invalid run list');
    record.runs = observed;
    const accepted = observed.filter((run) => matches(request, run));
    if (accepted.length === 1 && observed.length === 1) {
      record.state = 'bound';
      writeSnapshot(store, snapshot);
      return { state: 'bound', requestKey: request.requestKey, run: accepted[0]! };
    }
    if (observed.length > 1 || accepted.length > 1) {
      record.state = 'ambiguous';
      writeSnapshot(store, snapshot);
      return { state: 'ambiguous', requestKey: request.requestKey, runs: observed };
    }
    if (observed.length === 1) {
      record.state = 'unresolved';
      writeSnapshot(store, snapshot);
      return { state: 'unresolved', requestKey: request.requestKey, runs: observed };
    }
    if (!record.dispatchAttempted && request.event === 'workflow_dispatch') {
      record.dispatchAttempted = true;
      record.state = 'intent';
      writeSnapshot(store, snapshot);
      try {
        await provider.dispatch(request);
      } catch {
        record.state = 'unresolved';
        writeSnapshot(store, snapshot);
        return { state: 'unresolved', requestKey: request.requestKey, runs: [] };
      }
    }
    record.state = 'unresolved';
    writeSnapshot(store, snapshot);
    return { state: 'unresolved', requestKey: request.requestKey, runs: [] };
  });
}

/** Aggregate validation is deliberately a second gate over collector-issued job, artifact, and report facts. */
export function aggregateCiEvidence(
  plan: VerificationPlan,
  evidence: CollectedEvidence,
  expected: EvidenceExpectation,
) {
  const validation = validateEvidence(plan, evidence, expected);
  const requiredJobs = plan.obligations
    .filter((obligation) => obligation.executionBoundary === 'provider')
    .map((obligation) => `${obligation.criterionId}:${obligation.commandOrProviderJob}`);
  const missingJobs = requiredJobs.filter(
    (key) => !validation.records.some((record) => record.obligation === key),
  );
  const missingArtifacts = validation.records
    .filter((record) => record.provider?.artifactRequired && record.provider.artifact === undefined)
    .map((record) => `${record.obligation} has no required artifact`);
  return {
    ...validation,
    problems: [
      ...validation.problems,
      ...missingJobs.map((key) => `${key} has no job record`),
      ...missingArtifacts,
    ],
    ok: validation.ok && missingJobs.length === 0 && missingArtifacts.length === 0,
  };
}
