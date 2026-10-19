import { encode } from '../core/codec/index.ts';
import { storageConditionalBatch, type Storage } from '../storage/interface.ts';
import { workerBuildBinding, type WorkerBuildIdentity } from './deployment-records.ts';
import { throwIfWorkerBuildRemoved } from './inherited-worker-build.ts';

/**
 * Write a run record that binds the run to `build`, conditioned on the bytes read. The build is a
 * binding like any other: its tombstone must be absent, and its stamp moves with the run, so a
 * removal that read the stamp earlier cannot commit past it. A commit that lost to the build's
 * removal throws as removed; any other loss returns `false`.
 */
export async function commitWorkerBinding(
  storage: Storage,
  key: string,
  expectedBytes: Uint8Array,
  state: Record<string, unknown>,
  build: WorkerBuildIdentity,
): Promise<boolean> {
  const { condition, operation } = workerBuildBinding(build);
  const applied = await storageConditionalBatch(
    storage,
    [{ key, expectedValue: expectedBytes }, condition],
    [{ type: 'put', key, value: encode(state) }, operation],
  );
  if (!applied) await throwIfWorkerBuildRemoved(storage, build);
  return applied;
}
