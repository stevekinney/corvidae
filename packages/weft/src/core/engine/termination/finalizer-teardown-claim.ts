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
import { decode } from '../../codec.ts';
import type { EngineInternals } from '../internals.ts';
import { isTeardownClaim } from '../state-utilities.ts';
import {
  encodeOwedClaim,
  rearmTeardownTimer,
  settleOnRunningClaim,
  TEARDOWN_SELF_HEAL_DELAY_MS,
  teardownTimerOperations,
} from './finalizer-claim.ts';

/** A claim the drive holds; `release` is best-effort and never throws. */
export type TeardownClaimHold = { release: () => Promise<void> };

/**
 * Outcome of {@link acquireTeardownDriveClaim}: a hold to release when the drive ends, or
 * `'unavailable'` when another live engine (or this engine's own terminal path, which has
 * not yet released the claim it took for the run) owns the workflow's claim right now — the
 * caller backs off and re-arms its timer — or `'nothing-owed'` when the marker is already
 * gone or carries a different token (a stale timer — no claim round trip is spent on it).
 */
export type TeardownClaimAcquisition = TeardownClaimHold | 'unavailable' | 'nothing-owed';

const NO_CLAIM_NEEDED: TeardownClaimHold = { release: async () => undefined };

/**
 * Take the claim a finalizer drive needs for `workflowId`. Outside
 * `ownership: 'workflow-lease'` there is no per-workflow claim, so this resolves to a no-op
 * hold. The cheap, read-only checks run first, so a stale timer never spends (or is blocked
 * by) a claim round trip: a marker that is gone, or that carries a different token than the
 * fired timer, resolves to `'nothing-owed'`.
 *
 * A claim this engine already tracks while its epoch still matches storage is never reused:
 * it belongs to the terminal path that is about to release it (a self-terminal commits, then
 * releases — a scheduler tick can land in that gap, because the teardown timer is staged
 * with `fireAt` equal to the terminal time), so the drive would otherwise lose its claim
 * mid-run. It resolves to `'unavailable'` and the timer re-arms; the release is imminent. A
 * tracked-but-stale entry (an external terminal rotated the epoch under us) can never fence
 * a write again and is forgotten. Otherwise a fresh claim is acquired, falling back to a
 * takeover when the current holder's claim has expired.
 */
async function acquireTeardownDriveClaim(
  internals: EngineInternals,
  workflowId: string,
  token: string,
): Promise<TeardownClaimAcquisition> {
  const registry = internals.workflowClaimRegistry;
  if (internals.options.ownershipMode !== 'workflow-lease' || registry === null) {
    return NO_CLAIM_NEEDED;
  }
  const markerBytes = await internals.storage.get(KEYS.teardownOwed(workflowId));
  if (markerBytes === null || markerCarriesDifferentToken(markerBytes, token)) {
    return 'nothing-owed';
  }

  const trackedEpochBytes = registry.currentEpochBytes(workflowId);
  if (trackedEpochBytes !== null) {
    const storedEpochBytes = await internals.storage.get(KEYS.workflowOwnerEpoch(workflowId));
    if (storedEpochBytes !== null && bytesEqual(trackedEpochBytes, storedEpochBytes)) {
      return 'unavailable';
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
  const acquisition = await acquireTeardownDriveClaim(internals, workflowId, token);
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

/**
 * Whether the marker decodes to a valid claim stamped with a token other than `token`. An
 * undecodable or malformed marker returns `false`, so the drive still takes a claim and
 * clears it under the fence.
 */
function markerCarriesDifferentToken(markerBytes: Uint8Array, token: string): boolean {
  try {
    const decoded = decode(markerBytes);
    return isTeardownClaim(decoded) && decoded.token !== token;
  } catch {
    return false;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Settle a drive whose finalizer attempt was aborted by engine disposal: put the marker
 * back to `owed` at the unchanged `attempts` (settle-CAS'd on this drive's `runningBytes`)
 * and arm a near-future timer. A lost settle CAS means a reclaimer took the running bytes,
 * so the timer is re-armed anyway — the scheduler deletes the fired one, and the marker
 * must never be stranded.
 *
 * Under `workflow-lease`, disposal has already detached the claim registry and is releasing
 * the drive's claim, so a fenced settle can no longer be built: it would only emit a
 * spurious claim-lost warning and throw. The marker then stays `running` at the unchanged
 * attempt count (`claimTeardownMarker` never increments it); the next owner reclaims it
 * once the stale-running horizon passes and retries from the same count. Only the timer
 * is left behind, so that owner finds it.
 */
export async function reassertOwedAfterShutdown(
  internals: EngineInternals,
  workflowId: string,
  runningBytes: Uint8Array,
  attempts: number,
  token: string,
): Promise<void> {
  const claimsDetached =
    internals.options.ownershipMode === 'workflow-lease' &&
    internals.workflowClaimRegistry === null;
  if (!claimsDetached) {
    const fireAt = internals.options.getNow() + TEARDOWN_SELF_HEAL_DELAY_MS;
    const settled = await settleOnRunningClaim(internals, workflowId, runningBytes, [
      { type: 'put', key: KEYS.teardownOwed(workflowId), value: encodeOwedClaim(attempts, token) },
      ...teardownTimerOperations(token, workflowId, fireAt),
    ]);
    if (settled) return;
  }
  await rearmTeardownTimer(internals, workflowId, token, TEARDOWN_SELF_HEAL_DELAY_MS);
}
