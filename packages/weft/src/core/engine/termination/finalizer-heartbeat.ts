/**
 * Liveness heartbeat for a teardown drive (COR-1422). A finalizer that declares no `timeout`
 * runs unbounded, so the stale-running horizon cannot tell a live owner from a dead host. While
 * such a drive is live it renews its `running` marker with a fenced CAS: a fresh `claimedAt`
 * and a replacement watchdog, same token and attempt count. A marker that stops being renewed
 * is a dead host, which the stale reclaim may then take over and count.
 *
 * Renewal runs as a side timer. It never settles the marker: it only moves the hold's bytes
 * forward, so the drive's settle CAS follows the renewed bytes. A renewal that loses its CAS
 * means another drive reclaimed the marker, so renewal stops for good. It also stops on settle
 * and once the engine's shutdown signal aborts.
 *
 * @module core/engine/termination/finalizer-heartbeat
 */

import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import {
  runFinalizerActivity,
  type FinalizerAttemptResult,
  type RunnableFinalizer,
} from './finalizer-activity.ts';
import {
  encodeRunningClaim,
  teardownStaleThresholdMs,
  teardownTimerOperations,
  type TeardownHold,
} from './finalizer-claim.ts';

/** Renewals per stale horizon: a live drive renews well before a peer could judge it stale. */
const RENEWALS_PER_HORIZON = 3;

/** A running heartbeat: {@link TeardownHeartbeat.stop} halts it and reports any in-flight renewal. */
export interface TeardownHeartbeat {
  /**
   * Stop renewing. Returns the in-flight renewal, if any, which the caller must await before
   * settling so the settle CAS reads the renewed bytes; `undefined` when none is pending.
   */
  stop: () => Promise<void> | undefined;
}

const NO_HEARTBEAT: TeardownHeartbeat = { stop: () => undefined };

/**
 * Start renewing `hold` for a drive that holds the `running` marker. A finalizer with a
 * declared `timeout` is aborted by its own cap before the stale horizon, so it needs none.
 * `hold` is updated in place after each committed renewal.
 */
export function startTeardownHeartbeat(
  internals: EngineInternals,
  workflowId: string,
  hold: TeardownHold,
  spentAttempts: number,
  token: string,
  finalizer: RunnableFinalizer,
  firedAt: number,
): TeardownHeartbeat {
  if (finalizer.timeout !== undefined) return NO_HEARTBEAT;
  const horizonMs = teardownStaleThresholdMs(finalizer);
  let halted = false;
  let inFlight: Promise<void> | undefined;

  const halt = (): void => {
    halted = true;
    clearInterval(interval);
  };

  const renew = async (): Promise<boolean> => {
    const claimedAt = internals.options.getNow();
    const runningBytes = encodeRunningClaim(spentAttempts, token, claimedAt);
    const watchdog = teardownTimerOperations(token, workflowId, claimedAt + horizonMs, firedAt);
    const renewed = await commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      null,
      [
        ...hold.watchdogCleanup,
        { type: 'put', key: KEYS.teardownOwed(workflowId), value: runningBytes },
        ...watchdog,
      ],
      [{ key: KEYS.teardownOwed(workflowId), expectedValue: hold.bytes }],
    );
    if (renewed) {
      hold.bytes = runningBytes;
      hold.watchdogCleanup = watchdog.map((operation): BatchOperation => ({
        type: 'delete',
        key: operation.key,
      }));
    }
    return renewed;
  };

  const interval = setInterval(
    () => {
      if (halted || inFlight !== undefined) return;
      if (internals.abortController.signal.aborted) {
        halt();
        return;
      }
      const current: Promise<void> = renew().then((renewed) => {
        if (!renewed) halt();
        return undefined;
      }, halt);
      inFlight = current;
      void current.then(() => {
        if (inFlight === current) inFlight = undefined;
        return undefined;
      });
    },
    Math.floor(horizonMs / RENEWALS_PER_HORIZON),
  );

  return {
    stop: () => {
      halt();
      return inFlight;
    },
  };
}

/**
 * Run one finalizer attempt under a heartbeat, then let any in-flight renewal land so the
 * caller's settle CAS reads the renewed bytes. The wait happens only when a renewal is pending,
 * so the common path adds no `await` hop.
 */
export async function runFinalizerUnderHeartbeat(
  internals: EngineInternals,
  workflowId: string,
  hold: TeardownHold,
  claim: { spentAttempts: number; attempt: number; token: string; firedAt: number },
  finalizer: RunnableFinalizer,
  finalizerInput: unknown,
  workflowExecutionToken: string | undefined,
): Promise<FinalizerAttemptResult> {
  const heartbeat = startTeardownHeartbeat(
    internals,
    workflowId,
    hold,
    claim.spentAttempts,
    claim.token,
    finalizer,
    claim.firedAt,
  );
  let result: FinalizerAttemptResult;
  let renewalInFlight: Promise<void> | undefined;
  try {
    result = await runFinalizerActivity(
      finalizer,
      finalizerInput,
      claim.attempt,
      internals.abortController.signal,
      workflowExecutionToken,
    );
  } finally {
    renewalInFlight = heartbeat.stop();
  }
  if (renewalInFlight !== undefined) await renewalInFlight;
  return result;
}
