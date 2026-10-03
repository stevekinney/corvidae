/**
 * The per-workflow ownership claim a finalizer drive holds under
 * `ownership: 'workflow-lease'` (COR-1415).
 *
 * A workflow owes its definition-level finalizer only after it is `cancelled` or
 * `timed-out`. By then its per-workflow claim is gone: a self terminal releases it, and an
 * external cancel or timeout rotates the epoch and deletes the holder in the terminal
 * commit. Every durable write the drive makes to the `teardownOwed` marker is fenced on
 * `wf-owner-epoch:<workflowId>`, so a drive with no claim of its own fails closed on its
 * first write — forever, because the scheduler re-fires the timer.
 *
 * Opening an unfenced write path for the marker would fix that and give up the fence, so the
 * drive instead acquires a fresh claim for the length of the drive and releases it
 * afterwards. That keeps the marker writes fenced exactly as every other per-workflow write
 * is, and it makes the claim itself the arbiter between engines: two engines racing for the
 * same teardown cannot both hold the claim, the loser backs off and re-arms, and a holder
 * that dies is taken over by a peer once its claim expires. The marker's own byte-for-byte
 * CAS stays as the second line of defense.
 *
 * @module core/engine/termination/finalizer-teardown-claim
 */

import { KEYS } from '../../../storage/interface.ts';
import type { EngineInternals } from '../internals.ts';
import { rearmTeardownTimer, TEARDOWN_SELF_HEAL_DELAY_MS } from './finalizer-claim.ts';

/** A claim the drive holds; `release` is best-effort and never throws. */
export type TeardownClaimHold = { release: () => Promise<void> };

/**
 * Outcome of {@link acquireTeardownDriveClaim}: a hold to release when the drive ends, or
 * `'unavailable'` when another live engine owns the workflow's claim right now (the caller
 * backs off and re-arms its timer), or `'nothing-owed'` when the marker is already gone (a
 * stale timer — no claim round trip is spent on it).
 */
export type TeardownClaimAcquisition = TeardownClaimHold | 'unavailable' | 'nothing-owed';

const NOTHING_TO_RELEASE: TeardownClaimHold = { release: async () => undefined };

/**
 * Take the claim a finalizer drive needs for `workflowId`. Outside
 * `ownership: 'workflow-lease'` there is no per-workflow claim, so this resolves to a no-op
 * hold. A claim this engine already tracks is reused when its epoch still matches storage
 * (and is left for its real owner to release); a tracked-but-stale entry is forgotten
 * first. Otherwise a fresh claim is acquired, falling back to a takeover when the current
 * holder's claim has expired.
 */
async function acquireTeardownDriveClaim(
  internals: EngineInternals,
  workflowId: string,
): Promise<TeardownClaimAcquisition> {
  const registry = internals.workflowClaimRegistry;
  if (internals.options.ownershipMode !== 'workflow-lease' || registry === null) {
    return NOTHING_TO_RELEASE;
  }
  if ((await internals.storage.get(KEYS.teardownOwed(workflowId))) === null) return 'nothing-owed';

  const trackedEpochBytes = registry.currentEpochBytes(workflowId);
  if (trackedEpochBytes !== null) {
    const storedEpochBytes = await internals.storage.get(KEYS.workflowOwnerEpoch(workflowId));
    if (storedEpochBytes !== null && bytesEqual(trackedEpochBytes, storedEpochBytes)) {
      return NOTHING_TO_RELEASE;
    }
    // Deposed while still tracked (an external terminal rotated the epoch under us): the
    // cached bytes can never fence a write again, so drop them and take a fresh claim.
    registry.forgetLocalClaim(workflowId);
  }

  let epoch: number;
  const acquired = await registry.acquire(workflowId);
  if (acquired.status === 'acquired') {
    epoch = acquired.epoch;
  } else {
    const takeover = await registry.takeover(workflowId);
    if (takeover.status !== 'acquired') return 'unavailable';
    epoch = takeover.epoch;
  }

  return {
    release: async () => {
      try {
        await registry.release(workflowId, epoch);
      } catch {
        // Best-effort: an unreleased claim simply expires by TTL.
      }
    },
  };
}

/**
 * Run one finalizer drive (`drive`) while holding the claim it needs. A marker that is
 * already gone skips the drive without spending a claim round trip; a claim another live
 * engine owns re-arms the teardown timer for `token` and skips it, so the marker is never
 * stranded. The claim is released when the drive ends, however it ends.
 */
export async function withTeardownDriveClaim(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  drive: () => Promise<void>,
): Promise<void> {
  const acquisition = await acquireTeardownDriveClaim(internals, workflowId);
  if (acquisition === 'nothing-owed') return;
  if (acquisition === 'unavailable') {
    await rearmTeardownTimer(internals, workflowId, token, TEARDOWN_SELF_HEAL_DELAY_MS);
    return;
  }
  try {
    await drive();
  } finally {
    await acquisition.release();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
