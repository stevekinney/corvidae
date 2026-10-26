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
 * - **payload**: `{ runId: string, status: TaskSettlement['status'] }`, the state the settlement records. The status is
 *   for a reader of the history; a stream reads the settled record itself and uses the event only
 *   as the signal that it has been written.
 * - **deduplication**: one event per fire, however many processes settle it
 *   ({@link scheduleFireSettledDedupeKey}).
 *
 * The kind is additive inside the existing record wrapper, so the history's schema version stays
 * 1, and a reader that does not list it drops it.
 *
 * ## When it is appended, and what repairs a missing one
 *
 * - Every route that writes a fire's settlement announces it: the engine's terminal event, the
 *   recovery of a fire that ended while no process held it, and a direct cancel of a fire the
 *   cancelling process holds no run for.
 * - A rejected append is tried again, as a session persistence write is. One that still fails is
 *   diagnosed.
 * - A process that dies between writing the settlement and appending the event leaves none. Every
 *   boot reads the settled fires, finds the ones inside the event retention window whose event was
 *   never appended (the deduplication marker is absent), and appends it, dated where the fire ended
 *   (`emittedAtMs` is the settlement's own time), so a stream open on another process ends at the
 *   next boot of any Bureau on the store. This also covers a fire settled before this event
 *   existed, but only inside the window.
 * - A fire settled before the retention cutoff (`now` less `BureauRetentionOptions.events`) is left
 *   alone. Retention removes an event together with its deduplication marker, so such a fire has
 *   neither by design, and announcing it again would record one fire's end once per retention
 *   cycle. With events kept for ever, nothing is retired and there is no bound.
 *
 * What is not covered is the time until that boot: a stream open on a peer across a dead
 * settler's window hears nothing until then, and a client that reconnects reads the settled record
 * at once.
 */

import type { TaskSettlement } from './task-registry';

/** The `kind` of the one event that records a schedule fire's end. */
export const SCHEDULE_FIRE_SETTLED_EVENT_KIND = 'schedule.fire.settled';

/** The payload of a {@link SCHEDULE_FIRE_SETTLED_EVENT_KIND} event. */
export interface ScheduleFireSettledPayload {
  readonly runId: string;
  readonly status: TaskSettlement['status'];
}

/**
 * The deduplication key of a fire's one settled event. Two processes that both settle the fire (a
 * live end, and the recovery of a fire whose process died) write one event, not two.
 */
export function scheduleFireSettledDedupeKey(runId: string): string {
  return `${SCHEDULE_FIRE_SETTLED_EVENT_KIND}:${runId}`;
}
