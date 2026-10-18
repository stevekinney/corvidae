/**
 * Records a worker's deployment version in the durable catalog when its
 * registration is accepted (COR-277).
 *
 * `WorkerDeploymentCatalog` is what `weft.worker.deployments.*` lists, routes
 * between, drains, and removes, and what a workflow's worker-version binding
 * resolves against; without a write here nothing ever populates it. Both
 * transports call this after their in-memory `DeploymentConsistencyGuard` check
 * has passed, so a build id that conflicts with a connected worker's artifact
 * digest is refused before anything is written.
 *
 * The write is `registerVersion`, which is idempotent and race-safe: it creates
 * the version with a conditional batch that expects the key absent, and a lost
 * race re-reads the winner's record and compares identities. So the first
 * registration of a build fixes `firstSeenAt` and `state: 'ready'`, a repeat
 * registration (a reconnect, another worker of the same build, a concurrent
 * registration) returns the stored record untouched, and a version that has
 * been drained or removed is never moved back to `ready`.
 *
 * @module server/runtime/deployment-version-registration
 */
import { WorkerDeploymentVersionConflictError } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import type { ServerContext } from './context.ts';

export type DeploymentVersionRecording =
  | { readonly ok: true }
  /**
   * `conflict`: the stored version for this build has different digests, so the
   * registration is refused for good. `unavailable`: the catalog could not be
   * read or written, so the worker should retry; it is not accepted while the
   * catalog does not know its build.
   */
  | { readonly ok: false; readonly reason: 'conflict' | 'unavailable'; readonly message: string };

export async function recordDeploymentVersion(
  context: Pick<ServerContext, 'workerDeploymentCatalog'>,
  manifest: WorkerManifest,
  acceptedManifestDigest: string,
): Promise<DeploymentVersionRecording> {
  const catalog = context.workerDeploymentCatalog;
  if (catalog === undefined) return { ok: true };
  const { name, buildId, artifactDigest } = manifest.deployment;
  try {
    await catalog.registerVersion({
      deploymentName: name,
      buildId,
      artifactDigest,
      manifestDigest: acceptedManifestDigest,
      manifest,
      state: 'ready',
      firstSeenAt: Date.now(),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkerDeploymentVersionConflictError) {
      return { ok: false, reason: 'conflict', message: error.message };
    }
    return {
      ok: false,
      reason: 'unavailable',
      message: `The deployment catalog is unavailable, so deployment "${name}" build "${buildId}" could not be recorded; retry shortly.`,
    };
  }
}
