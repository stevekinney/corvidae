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
 * A takeover is never the first answer to an expired claim. The claim is renewed by a
 * background task that can stall (a GC pause, manual background tasks) while a long
 * finalizer is still running, and a takeover rotates the epoch, which fences the live
 * drive's settle and would make the finalizer run twice. So an expired claim is taken over
 * only once the marker is not a fresh `running` one (see `isFreshRunningMarker`); a live
 * drive's expired claim just re-arms.
 *
 * Design cost: a shutdown abort leaves the marker `running` (the detached registry cannot
 * build a fenced settle), so under `workflow-lease` the next owner waits out the stale
 * horizon (`teardownStaleThresholdMs`, about 5.5 minutes by default) before re-running the
 * teardown, instead of the near-immediate retry other ownership modes get.
 *
 * @module core/engine/termination/finalizer-teardown-claim
 */

import { KEYS } from '../../../storage/interface.ts';
import { decode } from '../../codec.ts';
import type { WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { isTeardownClaim } from '../state-utilities.ts';
import type { WorkflowClaimRegistry } from '../workflow-claim-registry.ts';
import {
  encodeOwedClaim,
  rearmTeardownTimer,
  runningClaimIsStale,
  settleOnRunningClaim,
  TEARDOWN_SELF_HEAL_DELAY_MS,
  teardownTimerOperations,
} from './finalizer-claim.ts';
import { resolveFinalizerRegistration } from './finalizer-registration.ts';

/** A claim the drive holds; `release` is best-effort and never throws. */
export type TeardownClaimHold = { release: () => Promise<void> };

/**
 * Outcome of {@link acquireTeardownDriveClaim}: a hold to release when the drive ends, or
 * `'unavailable'` when a live claim already exists for the workflow — another engine's
 * drive or reclaim-scan claim, this engine's own concurrent drive (`Scheduler.tick` is not
 * single-flight), this engine's terminal path before it releases its claim, or a fresh
 * `running` marker whose drive's claim merely expired — so the caller backs off and re-arms
 * its timer. The terminal path of a cancel or timeout does not itself leave a claim behind
 * (it rotates the epoch and deletes the holder atomically). The other outcome is `'nothing-owed'` when the marker is already
 * gone or carries a different token (a stale timer — no claim round trip is spent on it).
 */
export type TeardownClaimAcquisition = TeardownClaimHold | 'unavailable' | 'nothing-owed';

/** Loads a workflow's state, for the liveness judgment of a `running` marker. */
type WorkflowStateLoader = (workflowId: string) => Promise<WorkflowState | null>;

/** Terminal statuses that owe a definition-level finalizer teardown. */
export const TERMINAL_STATUSES_OWED_TEARDOWN: ReadonlySet<WorkflowState['status']> = new Set<
  WorkflowState['status']
>(['cancelled', 'timed-out']);

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
  loadWorkflowState: WorkflowStateLoader,
): Promise<TeardownClaimAcquisition> {
  const registry = internals.workflowClaimRegistry;
  if (internals.options.ownershipMode !== 'workflow-lease' || registry === null) {
    return NO_CLAIM_NEEDED;
  }
  const markerBytes = await internals.storage.get(KEYS.teardownOwed(workflowId));
  if (markerBytes === null || markerCarriesDifferentToken(markerBytes, token)) {
    return 'nothing-owed';
  }

  if (await trackedClaimIsLive(internals, registry, workflowId)) return 'unavailable';

  let epoch: number;
  const acquired = await registry.acquire(workflowId);
  if (acquired.status === 'acquired') {
    epoch = acquired.epoch;
  } else {
    // An expired claim does not mean a dead drive: a fresh `running` marker is a live
    // finalizer whose renewal stalled. Taking over would rotate the epoch, fence its settle,
    // and run the finalizer a second time once the marker goes stale.
    if (await isFreshRunningMarker(internals, workflowId, markerBytes, loadWorkflowState)) {
      return 'unavailable';
    }
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
 * Whether this engine tracks a claim for `workflowId` whose epoch still matches storage (the
 * terminal path's, or a concurrent drive's). A tracked-but-stale entry (deposed by an
 * external terminal) can never fence a write again, so it is forgotten and `false` returned.
 * The stored-epoch read awaits, so a concurrent drive on this engine may replace the entry
 * with its own live claim meanwhile; only the entry that was compared is forgotten (the
 * re-check and the forget run in the same synchronous turn).
 */
async function trackedClaimIsLive(
  internals: EngineInternals,
  registry: WorkflowClaimRegistry,
  workflowId: string,
): Promise<boolean> {
  const trackedEpochBytes = registry.currentEpochBytes(workflowId);
  if (trackedEpochBytes === null) return false;
  const storedEpochBytes = await internals.storage.get(KEYS.workflowOwnerEpoch(workflowId));
  if (storedEpochBytes !== null && bytesEqual(trackedEpochBytes, storedEpochBytes)) return true;
  const currentEpochBytes = registry.currentEpochBytes(workflowId);
  if (currentEpochBytes !== null && bytesEqual(currentEpochBytes, trackedEpochBytes)) {
    registry.forgetLocalClaim(workflowId);
  }
  return false;
}

/**
 * Whether `markerBytes` is a `running` claim still inside its stale-running horizon, so its
 * drive is presumed alive. Anything that cannot be resolved to a live drive (a corrupt or
 * `owed` marker, a vanished or ineligible workflow, an unregistered type) is not live: the
 * drive then takes the claim and resolves it as usual.
 */
async function isFreshRunningMarker(
  internals: EngineInternals,
  workflowId: string,
  markerBytes: Uint8Array,
  loadWorkflowState: WorkflowStateLoader,
): Promise<boolean> {
  let decoded: unknown;
  try {
    decoded = decode(markerBytes);
  } catch {
    return false;
  }
  if (!isTeardownClaim(decoded) || decoded.status !== 'running') return false;
  const state = await loadWorkflowState(workflowId);
  if (state === null || !TERMINAL_STATUSES_OWED_TEARDOWN.has(state.status)) return false;
  const finalizer = await resolveFinalizerRegistration(internals, state.type, state.revision);
  if (finalizer === undefined) return false;
  return !runningClaimIsStale(internals, decoded, finalizer);
}

/**
 * Run one finalizer drive (`drive`) while holding the claim it needs. A marker that is
 * already gone skips the drive without spending a claim round trip; a claim another live
 * engine owns re-arms the teardown timer for `token` and skips it, so the marker is never
 * stranded. The claim is released when the drive ends, however it ends.
 * `loadWorkflowState` lets the drive judge a `running` marker's liveness before an expired
 * claim is taken over.
 */
export async function withTeardownDriveClaim(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  loadWorkflowState: WorkflowStateLoader,
  drive: () => Promise<void>,
): Promise<void> {
  const acquisition = await acquireTeardownDriveClaim(
    internals,
    workflowId,
    token,
    loadWorkflowState,
  );
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
 * is left behind, so that owner finds it. The cost is latency: the next owner waits out
 * the stale-running horizon (`teardownStaleThresholdMs`, about 5.5 minutes by default)
 * before it re-runs the teardown, where the other ownership modes retry within the
 * self-heal delay.
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
