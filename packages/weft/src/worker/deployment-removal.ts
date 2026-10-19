/**
 * Removing a deployment build, fenced against every new binding (COR-1582).
 *
 * `removeWorkerDeploymentVersion` writes the build's removal fence (`deployment-removal-fence.ts`),
 * scans for the work bound to it, and then either writes `removed`, leaving the fence as the
 * tombstone, or deletes the fence and reports why it refused. A fence left by a removal that
 * crashed is reconciled by `reconcileRemovalFence`, which keeps the fence of a removed build and
 * deletes any other.
 */
import { decode, encode } from '../core/codec/index.ts';
import { storageConditionalBatch, type Storage } from '../storage/interface.ts';
import { countBuildReference } from './deployment-build-references.ts';
import { decodeRouting, decodeVersion, routingKey, versionKey } from './deployment-records.ts';
import {
  encodeRemovalFence,
  removalFenceKey,
  WORKER_DEPLOYMENT_REMOVAL_FENCE_PREFIX,
} from './deployment-removal-fence.ts';
import type {
  WorkerDeploymentRemovalOutcome,
  WorkerDeploymentVersion,
} from './deployment-routing.ts';

/** Delete a fence, only if it is still the one that was read; a fence already replaced is not ours to delete. */
async function releaseFence(
  storage: Storage,
  deploymentName: string,
  buildId: string,
  fence: Uint8Array,
): Promise<boolean> {
  const key = removalFenceKey(deploymentName, buildId);
  return storageConditionalBatch(
    storage,
    [{ key, expectedValue: fence }],
    [{ type: 'delete', key }],
  );
}

/**
 * Delete the fence of a build that is not removed: a removal that wrote it crashed before its
 * verdict. The fence of a removed build is its tombstone and stays. Returns whether a fence was
 * deleted. A removal still running against the fence it loses fails its own write, which is
 * conditioned on its fence's bytes, and starts over.
 */
export async function reconcileRemovalFence(
  storage: Storage,
  deploymentName: string,
  buildId: string,
): Promise<boolean> {
  const fence = await storage.get(removalFenceKey(deploymentName, buildId));
  if (fence === null) return false;
  const version = await storage.get(versionKey(deploymentName, buildId));
  if (version !== null && decodeVersion(version).state === 'removed') return false;
  return releaseFence(storage, deploymentName, buildId, fence);
}

/** Reconcile every fence in the store, at engine start. */
export async function reconcileRemovalFences(storage: Storage): Promise<void> {
  const builds: Array<[string, string]> = [];
  for await (const [, bytes] of storage.scan(WORKER_DEPLOYMENT_REMOVAL_FENCE_PREFIX)) {
    const fence = decode(bytes) as { deploymentName?: unknown; buildId?: unknown };
    if (typeof fence.deploymentName === 'string' && typeof fence.buildId === 'string') {
      builds.push([fence.deploymentName, fence.buildId]);
    }
  }
  for (const [deploymentName, buildId] of builds) {
    await reconcileRemovalFence(storage, deploymentName, buildId);
  }
}

/**
 * Mark a build removed, irreversibly, or report why it was not. Only a `draining` build can be
 * removed, because a draining build can no longer be chosen by a start or an upgrade. The fence is
 * written first, conditioned on the version record's and the routing pointer's exact bytes, so a
 * drain lifted or a routing change after the checks fails it; the scan then runs behind the
 * fence; and the removal write is conditioned on the same bytes and on the fence being the one this
 * removal wrote. A failed write releases the fence and checks again against what is true now.
 */
export async function removeWorkerDeploymentVersion(
  storage: Storage,
  deploymentName: string,
  buildId: string,
): Promise<WorkerDeploymentRemovalOutcome> {
  const key = versionKey(deploymentName, buildId);
  const currentBytes = await storage.get(key);
  if (currentBytes === null) return { outcome: 'not-found' };
  const current = decodeVersion(currentBytes);
  if (current.state === 'removed') return { outcome: 'not-found' };
  await reconcileRemovalFence(storage, deploymentName, buildId);
  const routingBytes = await storage.get(routingKey(deploymentName));
  const refusal = refusalBeforeFence(current, routingBytes);
  if (refusal !== undefined) return refusal;
  const fenceKey = removalFenceKey(deploymentName, buildId);
  const fence = encodeRemovalFence(deploymentName, buildId);
  const conditions = [
    { key, expectedValue: currentBytes },
    { key: routingKey(deploymentName), expectedValue: routingBytes },
  ];
  const fenced = await storageConditionalBatch(
    storage,
    [...conditions, { key: fenceKey, expectedValue: null }],
    [{ type: 'put', key: fenceKey, value: fence }],
  );
  if (!fenced) return removeWorkerDeploymentVersion(storage, deploymentName, buildId);
  let removed = false;
  try {
    const references = await countBuildReference(storage, { deploymentName, buildId });
    if (references > 0) return { outcome: 'referenced', references };
    removed = await storageConditionalBatch(
      storage,
      [...conditions, { key: fenceKey, expectedValue: fence }],
      [{ type: 'put', key, value: encode({ ...current, state: 'removed' as const }) }],
    );
    if (removed) return { outcome: 'removed' };
  } finally {
    if (!removed) await releaseFence(storage, deploymentName, buildId, fence);
  }
  return removeWorkerDeploymentVersion(storage, deploymentName, buildId);
}

/** Why a build cannot even be fenced: it is not draining, or the routing pointer names it. */
function refusalBeforeFence(
  current: WorkerDeploymentVersion,
  routingBytes: Uint8Array | null,
): WorkerDeploymentRemovalOutcome | undefined {
  if (current.state !== 'draining') return { outcome: 'not-draining', state: current.state };
  if (routingBytes === null) return undefined;
  const routing = decodeRouting(routingBytes);
  const routed =
    routing.currentBuildId === current.buildId || routing.rampingBuildId === current.buildId;
  return routed ? { outcome: 'routed' } : undefined;
}
