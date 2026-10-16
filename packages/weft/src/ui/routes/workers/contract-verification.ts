/**
 * Manifest-to-registry contract verification, computed in the browser (COR-162).
 *
 * `weft worker verify --manifest <path> --from <registry.json>` compares one worker manifest
 * file against one registry snapshot file. This module answers the same question from data the
 * dashboard already holds: the server-accepted manifest from `weft.workers.diagnostics`
 * ({@link WorkerManifestDiagnostics}) and the snapshot from `weft.system.registry`
 * ({@link RegistrySnapshotSource}).
 *
 * The comparison mirrors `collectManifestDrift`, `collectWorkflowIdentityDrift`, and
 * `collectActivityDrift` in `packages/weft/src/cli/worker-verify.ts`, which are CLI-internal and
 * not importable here: a workflow the manifest serves but the registry lacks is extra, a workflow
 * the registry lists but the manifest omits is missing, a served workflow is compared on
 * revision, workflow version, and contract hash, and each of its activities is compared on
 * contract hash, with extra and missing activities called out the same way.
 *
 * The registry snapshot carries each activity's schemas rather than its hash, so the expected
 * activity hash comes from `activityContractHash`, the public `@lostgradient/weft` export the CLI
 * itself calls. Nothing here re-derives the canonical serialization.
 *
 * @module routes/workers/contract-verification
 */
import { activityContractHash } from '@lostgradient/weft';

import type { KnownCompatibilityReason } from '../system/compatibility-verdict.ts';
import {
  activeManifests,
  type RegistrySnapshotSource,
  type WorkflowRevisionManifestSource,
} from '../system/registry-view.ts';
import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';

/** Every way a manifest can disagree with the active registry, in `weft worker verify`'s vocabulary. */
export type ContractDriftKind =
  | 'extra-workflow'
  | 'missing-workflow'
  | 'workflow-revision-mismatch'
  | 'workflow-version-mismatch'
  | 'workflow-contract-hash-mismatch'
  | 'extra-activity'
  | 'missing-activity'
  | 'activity-contract-hash-mismatch';

/** One disagreement between a worker manifest and the active registry snapshot. */
export interface ContractDriftEntry {
  readonly kind: ContractDriftKind;
  readonly workflowName: string;
  readonly activityName?: string;
  /** The registry's value, for an identity mismatch. */
  readonly expected?: string;
  /** The manifest's value, for an identity mismatch. */
  readonly actual?: string;
  /**
   * The compatibility reason the same disagreement would produce at activation time
   * (`compatibility-verdict.ts`'s `KNOWN_COMPATIBILITY_REASONS`), for an identity mismatch.
   */
  readonly reason?: KnownCompatibilityReason;
}

/** One worker's verification result. */
export interface ContractVerificationReport {
  readonly workerId: string;
  readonly deploymentName: string;
  readonly buildId: string;
  readonly manifestDigest: string;
  /** The workflows the comparison covered, sorted. */
  readonly workflows: readonly string[];
  readonly drift: readonly ContractDriftEntry[];
}

/** Operator copy for each drift kind. Every kind reads as text, never as color alone. */
export const CONTRACT_DRIFT_LABELS: Readonly<Record<ContractDriftKind, string>> = {
  'extra-workflow': 'Extra workflow',
  'missing-workflow': 'Missing workflow',
  'workflow-revision-mismatch': 'Revision mismatch',
  'workflow-version-mismatch': 'Workflow version mismatch',
  'workflow-contract-hash-mismatch': 'Workflow contract hash mismatch',
  'extra-activity': 'Extra activity',
  'missing-activity': 'Missing activity',
  'activity-contract-hash-mismatch': 'Activity contract hash mismatch',
};

/** One sentence explaining what each drift kind means for routing. */
export const CONTRACT_DRIFT_DESCRIPTIONS: Readonly<Record<ContractDriftKind, string>> = {
  'extra-workflow': 'The manifest serves a workflow the active registry does not list.',
  'missing-workflow': 'The active registry lists a workflow this manifest does not serve.',
  'workflow-revision-mismatch':
    'The manifest was built from a different revision than the active one.',
  'workflow-version-mismatch':
    'The manifest declares a different workflow version than the active revision.',
  'workflow-contract-hash-mismatch':
    'The manifest’s workflow payload contract differs from the active revision.',
  'extra-activity': 'The manifest implements an activity the active contract does not declare.',
  'missing-activity': 'The active contract declares an activity this manifest does not implement.',
  'activity-contract-hash-mismatch':
    'The activity’s input and result contract differs from the active revision.',
};

function compareCodepoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

type WorkerWorkflow = WorkerManifestDiagnostics['deploymentVersion']['workflows'][string];

function workflowIdentityDrift(
  workflowName: string,
  actual: WorkerWorkflow,
  expected: WorkflowRevisionManifestSource,
): ContractDriftEntry[] {
  const drift: ContractDriftEntry[] = [];
  if (actual.workflowRevision !== expected.revision) {
    drift.push({
      kind: 'workflow-revision-mismatch',
      workflowName,
      expected: expected.revision,
      actual: actual.workflowRevision,
      reason: 'artifact-revision-mismatch',
    });
  }
  if (actual.workflowVersion !== expected.workflowVersion) {
    drift.push({
      kind: 'workflow-version-mismatch',
      workflowName,
      expected: expected.workflowVersion,
      actual: actual.workflowVersion,
      reason: 'workflow-version-incompatible',
    });
  }
  if (actual.contractHash !== expected.contractHash) {
    drift.push({
      kind: 'workflow-contract-hash-mismatch',
      workflowName,
      expected: expected.contractHash,
      actual: actual.contractHash,
      reason: 'contract-hash-mismatch',
    });
  }
  return drift;
}

async function activityDrift(
  workflowName: string,
  actual: WorkerWorkflow,
  expected: WorkflowRevisionManifestSource,
): Promise<ContractDriftEntry[]> {
  const drift: ContractDriftEntry[] = [];
  const expectedActivities = expected.contract.activities ?? {};
  for (const activityName of Object.keys(actual.activities).toSorted(compareCodepoint)) {
    const expectedActivity = Object.hasOwn(expectedActivities, activityName)
      ? expectedActivities[activityName]
      : undefined;
    const actualActivity = actual.activities[activityName]!;
    if (expectedActivity === undefined) {
      drift.push({ kind: 'extra-activity', workflowName, activityName });
      continue;
    }
    // The CLI hashes exactly the schema pair, so this does too.
    const expectedHash = await activityContractHash({
      ...(expectedActivity.inputSchema !== undefined
        ? { inputSchema: expectedActivity.inputSchema }
        : {}),
      ...(expectedActivity.outputSchema !== undefined
        ? { outputSchema: expectedActivity.outputSchema }
        : {}),
    });
    if (actualActivity.contractHash !== expectedHash) {
      drift.push({
        kind: 'activity-contract-hash-mismatch',
        workflowName,
        activityName,
        expected: expectedHash,
        actual: actualActivity.contractHash,
        reason: 'contract-hash-mismatch',
      });
    }
  }
  for (const activityName of Object.keys(expectedActivities).toSorted(compareCodepoint)) {
    if (!Object.hasOwn(actual.activities, activityName)) {
      drift.push({ kind: 'missing-activity', workflowName, activityName });
    }
  }
  return drift;
}

/**
 * Compares one worker's accepted manifest with the active registry snapshot.
 *
 * With `workflowName`, only that workflow is compared, which is what a registry definition's
 * detail view needs; without it, every workflow on either side is, as `weft worker verify` does.
 */
export async function verifyWorkerManifest(
  diagnostics: WorkerManifestDiagnostics,
  snapshot: RegistrySnapshotSource,
  workflowName?: string,
): Promise<ContractVerificationReport> {
  const active = new Map(activeManifests(snapshot).map((manifest) => [manifest.name, manifest]));
  const served = diagnostics.deploymentVersion.workflows;
  const inScope = (name: string): boolean => workflowName === undefined || name === workflowName;
  const drift: ContractDriftEntry[] = [];

  const servedNames = Object.keys(served).filter(inScope).toSorted(compareCodepoint);
  for (const name of servedNames) {
    const expected = active.get(name);
    const actual = served[name]!;
    if (expected === undefined) {
      drift.push({ kind: 'extra-workflow', workflowName: name });
      continue;
    }
    drift.push(...workflowIdentityDrift(name, actual, expected));
    drift.push(...(await activityDrift(name, actual, expected)));
  }
  const registryNames = [...active.keys()].filter(inScope).toSorted(compareCodepoint);
  for (const name of registryNames) {
    if (!Object.hasOwn(served, name)) drift.push({ kind: 'missing-workflow', workflowName: name });
  }

  return {
    workerId: diagnostics.instance.workerId,
    deploymentName: diagnostics.deploymentVersion.deploymentName,
    buildId: diagnostics.deploymentVersion.buildId,
    manifestDigest: diagnostics.deploymentVersion.manifestDigest,
    workflows: [...new Set([...servedNames, ...registryNames])].toSorted(compareCodepoint),
    drift,
  };
}

/**
 * Verifies every manifest, sorted by worker identifier. With `workflowName`, only workers whose
 * manifest serves that workflow are verified, since a registry definition's detail view asks
 * which workers implement it.
 */
export async function verifyWorkerManifests(
  diagnostics: readonly WorkerManifestDiagnostics[],
  snapshot: RegistrySnapshotSource,
  workflowName?: string,
): Promise<readonly ContractVerificationReport[]> {
  const relevant =
    workflowName === undefined
      ? diagnostics
      : diagnostics.filter((entry) =>
          Object.hasOwn(entry.deploymentVersion.workflows, workflowName),
        );
  const reports = await Promise.all(
    relevant.map((entry) => verifyWorkerManifest(entry, snapshot, workflowName)),
  );
  return reports.toSorted((left, right) => compareCodepoint(left.workerId, right.workerId));
}

/** The label one drift entry is listed under: `workflow` or `workflow.activity`. */
export function contractDriftSubject(entry: ContractDriftEntry): string {
  return entry.activityName === undefined
    ? entry.workflowName
    : `${entry.workflowName}.${entry.activityName}`;
}

/** The suggested file name for the registry snapshot both commands read. */
export const REGISTRY_SNAPSHOT_FILE = 'weft-registry.json';

/** The suggested output path for `weft codegen`. */
export const CODEGEN_OUTPUT_FILE = 'weft-registry.d.ts';

/**
 * Reduces an identifier to characters every shell and file system accepts unquoted, so a
 * deployment name or build identifier can sit inside a copyable command without breaking it.
 */
export function shellSafeFileStem(value: string): string {
  const stem = value
    .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replaceAll(/^[-.]+|-+$/g, '')
    .slice(0, 80);
  return stem.length === 0 ? 'worker' : stem;
}

/** The manifest file name to verify, derived from the deployment and build the dashboard knows. */
export function manifestFileName(
  identity: Readonly<{ deploymentName: string; buildId: string }> | undefined,
): string {
  if (identity === undefined) return 'worker-manifest.json';
  return `${shellSafeFileStem(identity.deploymentName)}-${shellSafeFileStem(identity.buildId)}.manifest.json`;
}

/** The two canonical commands, with the flags `packages/weft/src/cli/help-text.ts` documents. */
export interface VerificationCommands {
  readonly codegen: string;
  readonly verify: string;
}

export function verificationCommands(
  identity: Readonly<{ deploymentName: string; buildId: string }> | undefined,
): VerificationCommands {
  return {
    codegen: `weft codegen --from ${REGISTRY_SNAPSHOT_FILE} --out ${CODEGEN_OUTPUT_FILE}`,
    verify: `weft worker verify --manifest ${manifestFileName(identity)} --from ${REGISTRY_SNAPSHOT_FILE}`,
  };
}
