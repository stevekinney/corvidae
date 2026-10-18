/**
 * The `weft.system.registry` boundary for contract verification (COR-162).
 * The generated operation output types the snapshot as `unknown`, so the
 * dashboard checks the fields verification reads before trusting them.
 *
 * ## Active revision pointers
 *
 * Every `activeRevisions` pointer must resolve to at most one manifest:
 * two manifests sharing `(name, revision)` would let two readers of the same
 * snapshot disagree about which contract is active, so that is malformed,
 * as it is for `weft codegen` (`indexManifestsByIdentity` in
 * `src/cli/codegen-validate.ts`). A pointer that resolves to no manifest is
 * not malformed: since WFT-11, `engine.workflows.activate()` can activate a
 * durably installed revision this process has no in-process manifest for
 * (`buildRegistrySnapshot` in `src/core/registry-snapshot.ts`), and codegen
 * omits such a name rather than failing. Verification resolves it the same
 * way, by omission.
 *
 * ## Canonical validation
 *
 * {@link parseRegistrySnapshot} accepts only the registry wire version this
 * build understands (`REGISTRY_VERSION`) and runs every manifest through
 * Weft's public `parseWorkflowRevisionManifest`, which recomputes each
 * `contractHash` from the contract instead of trusting the supplied value,
 * so verification never compares a worker with a hash the registry did not
 * earn.
 */
import { parseWorkflowRevisionManifest, REGISTRY_VERSION } from '@lostgradient/weft';

import type {
  RegistrySnapshotSource,
  WorkflowRevisionManifestSource,
} from '../system/registry-view.ts';

export class MalformedRegistrySnapshotError extends Error {
  constructor() {
    super('The server returned a malformed registry snapshot.');
    this.name = 'MalformedRegistrySnapshotError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** `true` when no two manifests share a `(name, revision)` identity. */
function hasUniqueManifestIdentities(
  manifests: readonly WorkflowRevisionManifestSource[],
): boolean {
  const byName = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const revisions = byName.get(manifest.name) ?? new Set<string>();
    if (revisions.has(manifest.revision)) return false;
    revisions.add(manifest.revision);
    byName.set(manifest.name, revisions);
  }
  return true;
}

/**
 * Checks the fields contract verification reads from `weft.system.registry`.
 * A type guard, so the snapshot is passed through whole: the Registry tab
 * shares its query key and reads the rest of each contract.
 */
function isRegistrySnapshot(value: unknown): value is RegistrySnapshotSource {
  if (
    !isRecord(value) ||
    value['registryVersion'] !== REGISTRY_VERSION ||
    !Array.isArray(value['workflows']) ||
    !isStringRecord(value['activeRevisions']) ||
    !isRecord(value['activities'])
  ) {
    return false;
  }
  const workflows: readonly unknown[] = value['workflows'];
  return workflows.every(isWorkflowManifest) && hasUniqueManifestIdentities(workflows);
}

/**
 * {@link isRegistrySnapshot}, then canonical validation of every manifest.
 * Throws {@link MalformedRegistrySnapshotError}; resolves to the snapshot
 * itself, whole, so the Registry tab can read the rest of each contract.
 */
export async function parseRegistrySnapshot(value: unknown): Promise<RegistrySnapshotSource> {
  if (!isRegistrySnapshot(value)) throw new MalformedRegistrySnapshotError();
  const results = await Promise.all(value.workflows.map(parseWorkflowRevisionManifest));
  if (results.some((result) => !result.ok)) throw new MalformedRegistrySnapshotError();
  return value;
}
