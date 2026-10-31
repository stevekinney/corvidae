/**
 * What a drain is confirmed against. The dialog takes the person's reason, and in the time they
 * take to type it the fleet moves: the worker may already be draining, may have left, or the
 * deployment may have gained or lost workers. A fingerprint of the target as the fleet listed it
 * when the dialog opened is compared with the one at confirmation, and a drain whose target
 * changed is refused, so the person sees what is there now before they act on it.
 */
import type { DrainTarget } from './drain-dialog.svelte';
import type { WorkerSummary } from './worker-catalog-types.ts';

/** Where the drain would land, such as `draining`, or the sorted workers of a deployment with their health. */
export type DrainFingerprint = string;

/**
 * A fingerprint of the workers a worker or deployment drain would affect, or `null` when none is
 * listed (the worker left, or no worker reports the deployment). A build target is not this
 * dialog's: the deployments panel confirms it against the routing generation.
 */
export function drainFingerprint(
  workers: readonly WorkerSummary[],
  target: DrainTarget,
): DrainFingerprint | null {
  if (target.kind === 'worker') {
    const worker = workers.find((candidate) => candidate.id === target.id);
    return worker === undefined ? null : worker.health;
  }
  if (target.kind === 'deployment') {
    const affected = workers
      .filter((candidate) => candidate.deploymentName === target.name)
      .map((candidate) => `${candidate.id}:${candidate.health}`)
      .toSorted();
    return affected.length === 0 ? null : affected.join(',');
  }
  return null;
}
