import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { ScheduleStaleRevisionError } from './schedule-stale-revision-error.ts';
import { requireScheduleState, runSerializedScheduleStateOperation } from './storage-io.ts';

/**
 * Run `operation` inside the schedule's serialized write, carrying a failure out of the
 * serialized body as a value and throwing it after.
 *
 * {@link runSerializedScheduleStateOperation} hands a rejection to whoever is queued behind it,
 * which is right for a timer callback that must leave its durable timer to be retried, and wrong
 * for anything else: one caller's refusal or failed write must not fail the next caller's change,
 * or a timer tick.
 */
export async function runIsolatedScheduleStateOperation<TResult>(
  internals: EngineInternals,
  scheduleId: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const outcome = await runSerializedScheduleStateOperation(
    internals,
    scheduleId,
    async (): Promise<{ ok: true; value: TResult } | { ok: false; error: unknown }> => {
      try {
        return { ok: true, value: await operation() };
      } catch (error) {
        return { ok: false, error };
      }
    },
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Run a schedule transition (a change a caller asked for) inside the schedule's serialized
 * write: load the current state, compare `expectedRevision` with its `revision` when the caller
 * passed one, and only then let `apply` decide what to write from that state. A stale
 * `expectedRevision` throws {@link ScheduleStaleRevisionError} and writes nothing.
 */
export async function runScheduleTransition(
  internals: EngineInternals,
  scheduleId: string,
  expectedRevision: number | undefined,
  apply: (state: ScheduleState) => Promise<void>,
): Promise<void> {
  await runIsolatedScheduleStateOperation(internals, scheduleId, async () => {
    const state = await requireScheduleState(internals, scheduleId);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new ScheduleStaleRevisionError(scheduleId, expectedRevision, state.revision);
    }
    await apply(state);
  });
}
