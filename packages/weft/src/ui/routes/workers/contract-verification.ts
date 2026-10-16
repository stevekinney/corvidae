/**
 * Worker contract verification (COR-162): compares a worker's canonical,
 * server-accepted manifest (`weft.workers.diagnostics`) with the active
 * registry snapshot (`weft.system.registry`), both of which the dashboard
 * already fetches.
 *
 * ## What this mirrors
 *
 * `weft worker verify` (`packages/weft/src/cli/worker-verify.ts`) reports
 * extra and missing workflows, workflow revision, version, and contract-hash
 * mismatches, extra and missing activities, and per-activity contract-hash
 * mismatches. This module reports the same findings. Like the CLI, it
 * derives each expected activity hash from the registry's schema pair with
 * Weft's own `activityContractHash` (a public root export), so the two
 * cannot drift. That hasher is asynchronous, so
 * {@link registryActivityContractHashes} runs once per snapshot and the
 * comparisons stay synchronous.
 *
 * A registry workflow the worker does not advertise is the CLI's `missing
 * workflow`. Workers often serve a subset of the registry, so those are
 * kept apart from drift on the workflows the worker does advertise.
 *
 * ## Strict payload failures versus contract mismatches
 *
 * The worker rejects an activity result or heartbeat payload that is not
 * strict JSON (`WorkerJsonValidationError`, `src/worker/strict-json.ts`) and
 * reports the error's message to the server. {@link classifyContractFailure}
 * recognizes that error by its name, or by the message vocabulary that
 * module emits; it never re-runs the validation rules. A contract mismatch is
 * a `Conflict` fault carrying `compatibilityReasons`
 * (`compatibility-verdict.ts`).
 */
import { activityContractHash, HttpClientError } from '@lostgradient/weft';

import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
import {
  type KNOWN_COMPATIBILITY_REASONS,
  readActivationConflictData,
} from '../system/compatibility-verdict.ts';
import type {
  RegistrySnapshotSource,
  WorkflowRevisionManifestSource,
} from '../system/registry-view.ts';
import {
  MalformedWorkerDiagnosticsError,
  type WorkerManifestDiagnostics,
} from './worker-manifest-diagnostics.ts';

type CompatibilityReason = (typeof KNOWN_COMPATIBILITY_REASONS)[number];

/** The identity reasons a manifest-to-registry comparison can report, named by the compatibility vocabulary. */
export type WorkflowIdentityReason = Extract<
  CompatibilityReason,
  'artifact-revision-mismatch' | 'workflow-version-incompatible' | 'contract-hash-mismatch'
>;

/**
 * Evaluation order matches `collectWorkflowIdentityDrift`: revision, then
 * version, then contract hash. The `Extract` above keeps each one a member
 * of `KNOWN_COMPATIBILITY_REASONS`.
 */
export const WORKFLOW_IDENTITY_REASONS: readonly WorkflowIdentityReason[] = [
  'artifact-revision-mismatch',
  'workflow-version-incompatible',
  'contract-hash-mismatch',
];

/** Operator copy for each identity reason, written for a worker-versus-registry comparison. */
export const WORKFLOW_IDENTITY_REASON_LABELS: Readonly<Record<WorkflowIdentityReason, string>> = {
  'artifact-revision-mismatch': 'Revision differs from the active registry revision',
  'workflow-version-incompatible': 'Workflow version differs from the active registry revision',
  'contract-hash-mismatch': 'Contract hash differs from the active registry revision',
};

export type WorkflowIdentityDrift = Readonly<{
  reason: WorkflowIdentityReason;
  worker: string;
  registry: string;
}>;

/** One activity's verification status. `mismatched`: both sides declare it, with different contract hashes. */
export type ActivityVerificationStatus = 'matched' | 'missing' | 'extra' | 'mismatched';

export type ActivityVerification = Readonly<{
  name: string;
  status: ActivityVerificationStatus;
  /** The worker's advertised activity contract hash; absent for a `missing` activity. */
  workerContractHash?: string;
  /** The hash the registry's schema pair produces; absent for an `extra` activity. */
  registryContractHash?: string;
}>;

export const ACTIVITY_STATUS_LABELS: Readonly<Record<ActivityVerificationStatus, string>> = {
  matched: 'Matches registry',
  missing: 'Missing from worker',
  extra: 'Not in registry',
  mismatched: 'Contract hash differs from registry',
};

/** `matched`: identity and activities agree. `drift`: they do not. `extra`: the registry has no active revision of it. */
export type WorkflowVerificationStatus = 'matched' | 'drift' | 'extra';

export type WorkflowVerification = Readonly<{
  workflow: string;
  status: WorkflowVerificationStatus;
  identityDrift: readonly WorkflowIdentityDrift[];
  activities: readonly ActivityVerification[];
}>;

export type WorkerContractVerification = Readonly<{
  workerId: string;
  deploymentName: string;
  buildId: string;
  /** Workflows the worker advertises, in codepoint order. */
  workflows: readonly WorkflowVerification[];
  /** Active registry workflows the worker does not advertise (the CLI's `missing workflow`). */
  notAdvertised: readonly string[];
  /** `true` when any advertised workflow is `drift` or `extra`. */
  hasDrift: boolean;
}>;

function compareCodepoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The active manifest of each workflow name, by the same `activeRevisions` rule `registry-view.ts` uses. */
function activeManifestsByName(
  snapshot: RegistrySnapshotSource,
): ReadonlyMap<string, WorkflowRevisionManifestSource> {
  const active = new Map<string, WorkflowRevisionManifestSource>();
  for (const manifest of snapshot.workflows) {
    if (snapshot.activeRevisions[manifest.name] === manifest.revision) {
      active.set(manifest.name, manifest);
    }
  }
  return active;
}

type WorkerWorkflow = WorkerManifestDiagnostics['deploymentVersion']['workflows'][string];

/** Expected activity contract hashes, by active workflow name, then activity name. */
export type RegistryActivityHashes = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Hashes every activity of every active registry revision the way `weft
 * worker verify` does: the schema pair only, through Weft's own
 * `activityContractHash`.
 */
export async function registryActivityContractHashes(
  snapshot: RegistrySnapshotSource,
): Promise<RegistryActivityHashes> {
  const entries = await Promise.all(
    [...activeManifestsByName(snapshot)].map(async ([workflow, manifest]) => {
      const activities = Object.entries(manifest.contract.activities ?? {});
      const hashes = await Promise.all(
        activities.map(
          async ([name, contract]) => [name, await activityContractHash(contract)] as const,
        ),
      );
      return [workflow, new Map(hashes)] as const;
    }),
  );
  return new Map(entries);
}

function identityDrift(
  actual: WorkerWorkflow,
  expected: WorkflowRevisionManifestSource,
): readonly WorkflowIdentityDrift[] {
  const values: Readonly<Record<WorkflowIdentityReason, readonly [string, string]>> = {
    'artifact-revision-mismatch': [actual.workflowRevision, expected.revision],
    'workflow-version-incompatible': [actual.workflowVersion, expected.workflowVersion],
    'contract-hash-mismatch': [actual.contractHash, expected.contractHash],
  };
  return WORKFLOW_IDENTITY_REASONS.flatMap((reason) => {
    const [worker, registry] = values[reason];
    return worker === registry ? [] : [{ reason, worker, registry }];
  });
}

function activityVerification(
  actual: WorkerWorkflow,
  expected: WorkflowRevisionManifestSource,
  expectedHashes: ReadonlyMap<string, string> | undefined,
): readonly ActivityVerification[] {
  const expectedActivities = expected.contract.activities ?? {};
  const names = new Set([...Object.keys(actual.activities), ...Object.keys(expectedActivities)]);
  return [...names].toSorted(compareCodepoint).map((name): ActivityVerification => {
    const advertised = actual.activities[name];
    const declared = expectedActivities[name] !== undefined;
    const registryHash = declared ? expectedHashes?.get(name) : undefined;
    const registryField = registryHash === undefined ? {} : { registryContractHash: registryHash };
    if (advertised === undefined) return { name, status: 'missing', ...registryField };
    if (!declared) return { name, status: 'extra', workerContractHash: advertised.contractHash };
    return {
      name,
      status: advertised.contractHash === registryHash ? 'matched' : 'mismatched',
      workerContractHash: advertised.contractHash,
      ...registryField,
    };
  });
}

/** Verifies one advertised workflow against the registry's active revision of the same name. */
function verifyWorkflow(
  workflow: string,
  actual: WorkerWorkflow,
  expected: WorkflowRevisionManifestSource | undefined,
  expectedHashes: ReadonlyMap<string, string> | undefined,
): WorkflowVerification {
  if (expected === undefined) {
    return {
      workflow,
      status: 'extra',
      identityDrift: [],
      activities: Object.keys(actual.activities)
        .toSorted(compareCodepoint)
        .map((name) => ({
          name,
          status: 'extra',
          workerContractHash: actual.activities[name]!.contractHash,
        })),
    };
  }
  const drift = identityDrift(actual, expected);
  const activities = activityVerification(actual, expected, expectedHashes);
  const activityDrift = activities.some((activity) => activity.status !== 'matched');
  return {
    workflow,
    status: drift.length > 0 || activityDrift ? 'drift' : 'matched',
    identityDrift: drift,
    activities,
  };
}

/**
 * Compares one worker's accepted manifest with the active registry snapshot.
 * `hashes` is {@link registryActivityContractHashes} of the same snapshot.
 */
export function verifyWorkerContracts(
  diagnostics: WorkerManifestDiagnostics,
  snapshot: RegistrySnapshotSource,
  hashes: RegistryActivityHashes,
): WorkerContractVerification {
  const active = activeManifestsByName(snapshot);
  const advertised = diagnostics.deploymentVersion.workflows;
  const workflows = Object.keys(advertised)
    .toSorted(compareCodepoint)
    .map((name) => verifyWorkflow(name, advertised[name]!, active.get(name), hashes.get(name)));
  return {
    workerId: diagnostics.instance.workerId,
    deploymentName: diagnostics.deploymentVersion.deploymentName,
    buildId: diagnostics.deploymentVersion.buildId,
    workflows,
    notAdvertised: [...active.keys()]
      .filter((name) => advertised[name] === undefined)
      .toSorted(compareCodepoint),
    hasDrift: workflows.some((workflow) => workflow.status !== 'matched'),
  };
}

export type WorkerWorkflowVerification = Readonly<{
  workerId: string;
  deploymentName: string;
  buildId: string;
  verification: WorkflowVerification;
}>;

export type RegistryWorkflowVerification = Readonly<{
  workflow: string;
  /** One entry per connected worker that advertises this workflow, by worker identifier. */
  workers: readonly WorkerWorkflowVerification[];
  /** Connected workers with an accepted manifest that do not advertise this workflow. */
  workersNotAdvertising: number;
}>;

/** Compares every connected worker that advertises `workflow` with the registry's active revision of it. */
export function verifyRegistryWorkflow(
  workflow: string,
  diagnostics: readonly WorkerManifestDiagnostics[],
  snapshot: RegistrySnapshotSource,
  hashes: RegistryActivityHashes,
): RegistryWorkflowVerification {
  const expected = activeManifestsByName(snapshot).get(workflow);
  const expectedHashes = hashes.get(workflow);
  const workers = diagnostics
    .flatMap((entry): WorkerWorkflowVerification[] => {
      const actual = entry.deploymentVersion.workflows[workflow];
      if (actual === undefined) return [];
      return [
        {
          workerId: entry.instance.workerId,
          deploymentName: entry.deploymentVersion.deploymentName,
          buildId: entry.deploymentVersion.buildId,
          verification: verifyWorkflow(workflow, actual, expected, expectedHashes),
        },
      ];
    })
    .toSorted((left, right) => compareCodepoint(left.workerId, right.workerId));
  return { workflow, workers, workersNotAdvertising: diagnostics.length - workers.length };
}

// ---------------------------------------------------------------------------
// Copyable CLI commands
// ---------------------------------------------------------------------------

/** File-name-safe slug: anything outside `[A-Za-z0-9._-]` becomes `-`. */
function fileSlug(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'unnamed' : slug;
}

export type VerificationCommandContext = Readonly<{
  /** The worker's deployment and build, when one worker is in view. */
  deploymentName?: string;
  buildId?: string;
  /** The registry snapshot's `registryVersion`, when a snapshot is loaded. */
  registryVersion?: number;
}>;

export type VerificationCommands = Readonly<{
  registryFile: string;
  manifestFile: string;
  codegen: string;
  workerVerify: string;
}>;

/**
 * The canonical `weft codegen --from <path> --out <file>` and `weft worker
 * verify --manifest <path> --from <registry.json>` commands
 * (`src/cli/help-text.ts`), with file names derived from what the dashboard
 * knows. Paths are local files the operator saves; the dashboard never
 * writes them.
 */
export function verificationCommands(context: VerificationCommandContext): VerificationCommands {
  const registryFile =
    context.registryVersion === undefined
      ? 'registry.json'
      : `registry-v${String(context.registryVersion)}.json`;
  const manifestFile =
    context.deploymentName === undefined || context.buildId === undefined
      ? 'worker-manifest.json'
      : `${fileSlug(context.deploymentName)}-${fileSlug(context.buildId)}.manifest.json`;
  return {
    registryFile,
    manifestFile,
    codegen: `weft codegen --from ${registryFile} --out weft-registry.d.ts`,
    workerVerify: `weft worker verify --manifest ${manifestFile} --from ${registryFile}`,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type ContractFailure =
  | Readonly<{ kind: 'strict-payload'; path: string; message: string }>
  | Readonly<{ kind: 'contract-mismatch'; reasons: readonly string[] }>;

const STRICT_PAYLOAD_ERROR_NAME = 'WorkerJsonValidationError';

/**
 * The reason suffixes `strict-json.ts` writes after `<path>: `. Recognizing
 * the vocabulary is not re-validating: nothing here inspects a payload.
 */
const STRICT_PAYLOAD_MESSAGE =
  /^(.+?): (.+ is not valid worker JSON|.+ is not a plain JSON object|number must be finite)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictPayloadFromMessage(message: string): ContractFailure | undefined {
  const match = STRICT_PAYLOAD_MESSAGE.exec(message);
  if (match === null) return undefined;
  return { kind: 'strict-payload', path: match[1]!, message: match[2]! };
}

function strictPayloadFromRecord(record: Record<string, unknown>): ContractFailure | undefined {
  const name = record['name'] ?? record['code'] ?? record['weftCode'];
  const message = typeof record['message'] === 'string' ? record['message'] : '';
  if (name !== STRICT_PAYLOAD_ERROR_NAME) return undefined;
  if (typeof record['path'] === 'string') {
    const prefix = `${record['path']}: `;
    return {
      kind: 'strict-payload',
      path: record['path'],
      message: message.startsWith(prefix) ? message.slice(prefix.length) : message,
    };
  }
  return strictPayloadFromMessage(message) ?? { kind: 'strict-payload', path: 'payload', message };
}

/**
 * Classifies a server-reported failure as a strict payload-boundary
 * rejection or a contract mismatch, or `undefined` for anything else (which
 * keeps its ordinary fault treatment). Accepts a failed task's error string,
 * an `HttpClientError`, or an error-shaped object.
 */
export function classifyContractFailure(failure: unknown): ContractFailure | undefined {
  if (typeof failure === 'string') return strictPayloadFromMessage(failure);
  if (failure instanceof HttpClientError) {
    const conflict = readActivationConflictData(failure);
    if (conflict?.compatibilityReasons !== undefined) {
      return { kind: 'contract-mismatch', reasons: conflict.compatibilityReasons };
    }
    const fromData = isRecord(failure.data) ? strictPayloadFromRecord(failure.data) : undefined;
    return fromData ?? strictPayloadFromMessage(failure.message);
  }
  if (failure instanceof Error) {
    return (
      strictPayloadFromRecord({
        name: failure.name,
        message: failure.message,
        path: 'path' in failure ? failure.path : undefined,
      }) ?? strictPayloadFromMessage(failure.message)
    );
  }
  if (isRecord(failure)) return strictPayloadFromRecord(failure);
  return undefined;
}

// ---------------------------------------------------------------------------
// Registry snapshot boundary
// ---------------------------------------------------------------------------

export class MalformedRegistrySnapshotError extends Error {
  constructor() {
    super('The server returned a malformed registry snapshot.');
    this.name = 'MalformedRegistrySnapshotError';
  }
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isWorkflowManifest(value: unknown): value is WorkflowRevisionManifestSource {
  if (!isRecord(value) || !isRecord(value['contract'])) return false;
  const activities = value['contract']['activities'];
  return (
    typeof value['manifestVersion'] === 'number' &&
    typeof value['name'] === 'string' &&
    typeof value['workflowVersion'] === 'string' &&
    typeof value['revision'] === 'string' &&
    typeof value['contractHash'] === 'string' &&
    (activities === undefined || isRecord(activities))
  );
}

/**
 * Checks the fields contract verification reads from `weft.system.registry`,
 * whose generated output types them as `unknown`. A type guard, so the
 * snapshot is passed through whole: the Registry tab shares its query key
 * and reads the rest of each contract.
 */
export function isRegistrySnapshot(value: unknown): value is RegistrySnapshotSource {
  return (
    isRecord(value) &&
    typeof value['registryVersion'] === 'number' &&
    Array.isArray(value['workflows']) &&
    value['workflows'].every(isWorkflowManifest) &&
    isStringRecord(value['activeRevisions']) &&
    isRecord(value['activities'])
  );
}

// ---------------------------------------------------------------------------
// Panel faults
// ---------------------------------------------------------------------------

/** How a verification panel presents the error from either of its two queries. */
export type VerificationFault =
  | Readonly<{ kind: 'contract'; failure: ContractFailure }>
  | Readonly<{ kind: 'malformed'; message: string }>
  | Readonly<{ kind: 'permission-denied'; message: string }>
  | Readonly<{ kind: 'server'; title: string; message: string }>;

/** Checks in an order that keeps a recognized contract failure or a malformed response from reading as a generic fault. */
export function verificationFault(error: unknown): VerificationFault {
  const failure = classifyContractFailure(error);
  if (failure !== undefined) return { kind: 'contract', failure };
  if (
    error instanceof MalformedWorkerDiagnosticsError ||
    error instanceof MalformedRegistrySnapshotError
  ) {
    return { kind: 'malformed', message: error.message };
  }
  const treatment = faultTreatment(error);
  if (treatment.kind === 'unauthorized') {
    return { kind: 'permission-denied', message: treatment.message };
  }
  return {
    kind: 'server',
    title: FAULT_TREATMENT_TITLE[treatment.kind],
    message: treatment.message,
  };
}
