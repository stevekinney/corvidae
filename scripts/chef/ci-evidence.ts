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
  /** Coordinator request identity; distinct from an event receipt's manual input. */
  requestKey: string;
  receiptRequestKey: string;
  /** Authenticated checkout identity from the receipt artifact. */
  checkedRevision: string;
  checkedTree: string;
  receiptJobs: Record<string, 'success' | 'not-applicable'>;
  receiptReports?: Record<string, { reports: number; testCases: number }>;
  /** Exact affected test files selected by the authenticated pull-request tests job. */
  receiptTests?: string[];
  attempt: number;
  jobs: string[];
}

/** The stable identity known before inspecting an automatic pull-request receipt. */
export interface AutomaticPullRequestEvidenceRequest {
  repository: string;
  resource: string;
  base: string;
  candidate: string;
  integrationTree: string;
  workflow: string;
  workflowPath: string;
}

export type CiEvidenceObservation =
  CiEvidenceRun | { state: 'pending' | 'failed' | 'canceled'; id: number; attempt: number };

export interface CiEvidenceProvider {
  findRuns(request: CiEvidenceRequest): Promise<CiEvidenceObservation[]>;
  /** Finds only authenticated, completed automatic pull-request receipts for this exact merge. */
  findAutomaticPullRequestRuns?(
    request: AutomaticPullRequestEvidenceRequest,
  ): Promise<CiEvidenceRun[]>;
  dispatch(request: CiEvidenceRequest): Promise<void>;
}

interface StoredRequest {
  request: CiEvidenceRequest;
  dispatchAttempted: boolean;
  state: 'intent' | 'unresolved' | 'bound' | 'ambiguous' | 'failed' | 'canceled';
  runs: CiEvidenceObservation[];
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

function recordPath(store: CiEvidenceStore, requestKey: string): string {
  return join(store.stateDirectory, 'ci-evidence-requests', `${requestKey}.json`);
}

function readRecord(store: CiEvidenceStore, requestKey: string): StoredRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath(store, requestKey), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new CiEvidenceError('CI evidence record is malformed');
    return parsed as StoredRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof CiEvidenceError) throw error;
    throw new CiEvidenceError('CI evidence record is unreadable');
  }
}

function writeRecord(store: CiEvidenceStore, requestKey: string, record: StoredRequest): void {
  const path = recordPath(store, requestKey);
  mkdirSync(join(store.stateDirectory, 'ci-evidence-requests'), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`);
    renameSync(temporary, path);
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
    (request.event === 'workflow_dispatch'
      ? run.receiptRequestKey === request.requestKey
      : run.receiptRequestKey === '') &&
    commit(run.checkedRevision) &&
    commit(run.checkedTree) &&
    Number.isSafeInteger(run.attempt) &&
    run.attempt >= 1 &&
    Array.isArray(run.jobs) &&
    run.jobs.length > 0 &&
    run.jobs.every(text)
  );
}

export type CiEvidenceReconciliation =
  | { state: 'bound'; requestKey: string; run: CiEvidenceRun }
  | {
      state: 'unresolved' | 'ambiguous' | 'failed' | 'canceled';
      requestKey: string;
      runs: CiEvidenceObservation[];
    };

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
    let record = readRecord(store, request.requestKey);
    if (record === undefined) {
      record = { request, dispatchAttempted: false, state: 'intent', runs: [] };
      writeRecord(store, request.requestKey, record);
    } else if (ciEvidenceRequestKey(record.request) !== request.requestKey) {
      throw new CiEvidenceError('CI evidence request key has conflicting durable intent');
    }

    const known = record.runs[0];
    if (
      record.state === 'bound' &&
      record.runs.length === 1 &&
      known !== undefined &&
      !('state' in known) &&
      matches(request, known)
    )
      return { state: 'bound', requestKey: request.requestKey, run: known };
    const previouslyObserved = (): CiEvidenceReconciliation => ({
      state: record.state === 'canceled' || record.state === 'failed' ? record.state : 'unresolved',
      requestKey: request.requestKey,
      runs: record.runs,
    });

    let observed: CiEvidenceObservation[];
    try {
      observed = await provider.findRuns(request);
    } catch {
      return previouslyObserved();
    }
    if (!Array.isArray(observed))
      throw new CiEvidenceError('CI provider returned an invalid run list');
    if (observed.length === 0 && record.runs.length > 0) return previouslyObserved();
    record.runs = observed;
    const accepted = observed.filter(
      (run): run is CiEvidenceRun => !('state' in run) && matches(request, run),
    );
    if (accepted.length === 1 && observed.length === 1) {
      record.state = 'bound';
      writeRecord(store, request.requestKey, record);
      return { state: 'bound', requestKey: request.requestKey, run: accepted[0]! };
    }
    if (observed.length > 1 || accepted.length > 1) {
      record.state = 'ambiguous';
      writeRecord(store, request.requestKey, record);
      return { state: 'ambiguous', requestKey: request.requestKey, runs: observed };
    }
    const single = observed[0];
    if (
      observed.length === 1 &&
      single !== undefined &&
      'state' in single &&
      (single.state === 'canceled' || single.state === 'failed')
    ) {
      record.state = single.state;
      writeRecord(store, request.requestKey, record);
      return { state: single.state, requestKey: request.requestKey, runs: observed };
    }
    if (observed.length === 1) {
      record.state = 'unresolved';
      writeRecord(store, request.requestKey, record);
      return { state: 'unresolved', requestKey: request.requestKey, runs: observed };
    }
    if (!record.dispatchAttempted && request.event === 'workflow_dispatch') {
      record.dispatchAttempted = true;
      record.state = 'intent';
      writeRecord(store, request.requestKey, record);
      try {
        await provider.dispatch(request);
      } catch {
        record.state = 'unresolved';
        writeRecord(store, request.requestKey, record);
        return { state: 'unresolved', requestKey: request.requestKey, runs: [] };
      }
    }
    record.state = 'unresolved';
    writeRecord(store, request.requestKey, record);
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
  const missingArtifacts = validation.records
    .filter((record) => record.provider?.artifactRequired && record.provider.artifact === undefined)
    .map((record) => `${record.obligation} has no required artifact`);
  return {
    ...validation,
    problems: [...validation.problems, ...missingArtifacts],
    ok: validation.ok && missingArtifacts.length === 0,
  };
}
