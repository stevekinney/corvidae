/**
 * The removal fence: the durable record that keeps new work off a build while it is removed, and
 * afterwards.
 *
 * Removal's scan counts the work bound to a build, and it cannot see a binding committed after it.
 * So removal first writes a fence for the build, then scans, and every commit that binds a run to
 * a build (a fresh start, a restart, a fork, a child, an automatic upgrade) requires that build's
 * fence to be absent. A binding committed before the fence is visible to the scan that follows it,
 * and one committed after it fails its condition.
 *
 * Stored at `worker-deployment-removal:<deployment>:<build>` (name and id URI-encoded, as in the
 * version record's key), as the MessagePack encoding of:
 *
 * - `deploymentName`, `buildId`: the build, for a sweep that finds the key without parsing it;
 * - `token`: a random string unique to the removal that wrote it, so that a removal's write is
 *   conditioned on its own fence and not on whichever fence is there;
 * - `fencedAt`: the epoch milliseconds the removal began, for an operator reading the record.
 *
 * Lifecycle: a removal that succeeds writes `removed` and leaves the fence in place as the build's
 * permanent tombstone, so every later binding commit fails. A removal that is refused deletes it.
 * A removal that crashed between the fence and its verdict leaves a fence on a build that is not
 * `removed`; `deployment-removal.ts` reconciles that at engine start and on the next remove or
 * resume of the build.
 */
import { encode } from '../core/codec/index.ts';
import type { ConditionalBatchCondition } from '../storage/interface.ts';

export const WORKER_DEPLOYMENT_REMOVAL_FENCE_PREFIX = 'worker-deployment-removal:';

export function removalFenceKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_REMOVAL_FENCE_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

/** A new fence record for a removal beginning now. */
export function encodeRemovalFence(deploymentName: string, buildId: string): Uint8Array {
  return encode({ deploymentName, buildId, token: crypto.randomUUID(), fencedAt: Date.now() });
}

/**
 * The condition every commit that binds a run to `binding`'s build adds: the build's fence key is
 * absent. An older build removed before fences existed has none, which is why a restart and a fork
 * also read the version record (`inherited-worker-build.ts`).
 */
export function workerBuildFenceAbsentCondition(
  binding: Readonly<{ deploymentName: string; buildId: string }>,
): ConditionalBatchCondition {
  return {
    key: removalFenceKey(binding.deploymentName, binding.buildId),
    expectedValue: null,
  };
}
