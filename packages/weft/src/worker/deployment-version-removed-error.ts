/**
 * A restart or fork would inherit a worker binding whose deployment build has been removed. A
 * removed build can never run work again, so the new run is refused rather than bound to it.
 * Distinct from other failures so the operations that start or fork a run can report it as a
 * conflict with the deployment state (`reason: "version-removed"`) rather than as an engine
 * failure.
 */
export class WorkerDeploymentVersionRemovedError extends Error {
  readonly deploymentName: string;
  readonly buildId: string;

  constructor(deploymentName: string, buildId: string) {
    super(
      `Deployment build ${deploymentName}/${buildId} has been removed, so a run bound to it cannot be restarted or forked onto it.`,
    );
    this.name = 'WorkerDeploymentVersionRemovedError';
    this.deploymentName = deploymentName;
    this.buildId = buildId;
  }
}
