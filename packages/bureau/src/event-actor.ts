/**
 * Who asked for a schedule's creation (COR-2545). The actor is an envelope field, like an event's
 * source (`event-source.ts`): an event class has fields of its own, and the operative package that
 * dispatches `schedule.created` knows nothing of callers. The Bureau marks the event where it
 * dispatches it for a caller, and the audit trail reads the mark when it records the event.
 *
 * @module event-actor
 */

import type { ScheduleActor } from './bureau-types/schedules';

const eventActors = new WeakMap<object, ScheduleActor>();

/** Marks `event` as asked for by `actor` and returns it; call it before the event is dispatched. */
export function markEventActor<TEvent extends object>(event: TEvent, actor: ScheduleActor): TEvent {
  eventActors.set(event, actor);
  return event;
}

/** The actor `event` was marked with, or `undefined` for an event no caller asked for. */
export function eventActorOf(event: unknown): ScheduleActor | undefined {
  return typeof event === 'object' && event !== null ? eventActors.get(event) : undefined;
}
