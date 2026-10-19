import type { Storage } from '../storage/interface.ts';
import { removalFenceKey } from './deployment-removal-fence.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import {
  WorkerDeploymentVersionRemovedError,
  WorkerDeploymentVersionRemovingError,
} from './deployment-version-removed-error.ts';

type BuildIdentity = Readonly<{ deploymentName: string; buildId: string }>;

/**
 * Refuse a run that would inherit a worker binding whose build has been removed. A restart or a
 * fork copies the binding of a terminal run, which the reference scan does not count. This read
 * fails fast, and it also covers a build removed before removal fences existed; the commit itself
 * is fenced by `workerBuildFenceAbsentCondition`. A build the catalog has never heard of is not
 * refused: nothing removed it.
 */
export async function assertInheritedWorkerBuildNotRemoved(
  storage: Storage,
  binding: BuildIdentity,
): Promise<void> {
  const version = await new WorkerDeploymentCatalog(storage).getVersion(
    binding.deploymentName,
    binding.buildId,
  );
  if (version?.state === 'removed') {
    throw new WorkerDeploymentVersionRemovedError(binding.deploymentName, binding.buildId);
  }
}

/**
 * After a commit that binds a run to `binding`'s build lost, say why: the build is `removed`, or it
 * is being removed. Returns `false` when the fence is gone, so the loss was to a removal that has
 * since been refused and the commit can be tried again.
 */
export async function throwIfWorkerBuildFenced(
  storage: Storage,
  binding: BuildIdentity,
): Promise<boolean> {
  const fence = await storage.get(removalFenceKey(binding.deploymentName, binding.buildId));
  if (fence === null) return false;
  await assertInheritedWorkerBuildNotRemoved(storage, binding);
  throw new WorkerDeploymentVersionRemovingError(binding.deploymentName, binding.buildId);
}
