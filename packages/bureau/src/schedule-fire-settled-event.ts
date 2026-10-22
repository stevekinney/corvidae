/**
 * The durable event that ends a schedule fire's stream on every process (COR-1594).
 *
 * A fire runs headless on the durable engine, and the process that settles it records the end in
 * the shared task registry and announces it to its own listeners. A `bureau.tasks.events` stream
 * served by another process sharing the stores has no listener of that process's to hear it, so
 * the settling process also appends this event to the fire's durable history, which every process
 * can follow. It is appended once the settlement is written, so a reader that is told of it finds
 * the settled record.
 *
 * ## Persisted format
 *
 * - **owner**: the fire's own run, `{ kind: 'run', id: <fire task id> }`, beside the
 *   `schedule.completed` and `schedule.failed` events the same run already records. It is not the
 *   schedule's owner, which a fire never writes to: a schedule's durable page carries its
 *   definition, never its fires (see `durable-event-history.ts`), and a fire's task record carries
 *   no schedule id to find that owner by.
 * - **kind**: {@link SCHEDULE_FIRE_SETTLED_EVENT_KIND}.
 * - **payload**: `{ runId: string, status: 'completed' | 'failed' | 'canceled' }`. The status is
 *   for a reader of the history; a stream reads the settled record itself and uses the event only
 *   as the signal that it has been written.
 * - **deduplication**: one event per fire, however many processes settle it
 *   ({@link scheduleFireSettledDedupeKey}).
 *
 * The kind is additive inside the existing record wrapper, so the history's schema version stays
 * 1, and a reader that does not list it drops it. A fire settled before this event existed has
 * none: a stream another process serves for it ends only when that process hears of the end some
 * other way.
 */

/** The `kind` of the one event that records a schedule fire's end. */
export const SCHEDULE_FIRE_SETTLED_EVENT_KIND = 'schedule.fire.settled';

/** The payload of a {@link SCHEDULE_FIRE_SETTLED_EVENT_KIND} event. */
export interface ScheduleFireSettledPayload {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'canceled';
}

/**
 * The deduplication key of a fire's one settled event. Two processes that both settle the fire (a
 * live end, and the recovery of a fire whose process died) write one event, not two.
 */
export function scheduleFireSettledDedupeKey(runId: string): string {
  return `${SCHEDULE_FIRE_SETTLED_EVENT_KIND}:${runId}`;
}
