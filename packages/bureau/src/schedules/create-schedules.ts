import type { Bureau, BureauSchedules } from '../types.ts';

/**
 * What {@link createSchedules} composes `bureau.schedules` from: the Bureau's own schedule
 * implementations, which share its durable engine, event emitter, and outbox and so are built
 * where that state lives, and the durable event history the schedule owner kind is read from.
 */
export type SchedulesDependencies = {
  /** {@link BureauSchedules.create}. */
  readonly create: BureauSchedules['create'];
  /** {@link BureauSchedules.get}. */
  readonly get: BureauSchedules['get'];
  /** {@link BureauSchedules.list}. */
  readonly list: BureauSchedules['list'];
  /** {@link BureauSchedules.pause}. */
  readonly pause: BureauSchedules['pause'];
  /** {@link BureauSchedules.resume}. */
  readonly resume: BureauSchedules['resume'];
  /** {@link BureauSchedules.cancel}. */
  readonly cancel: BureauSchedules['cancel'];
  /** {@link BureauSchedules.update}. */
  readonly update: BureauSchedules['update'];
  /** {@link BureauSchedules.agentName}. */
  readonly agentName: BureauSchedules['agentName'];
  /** {@link BureauSchedules.inputPreview}. */
  readonly inputPreview: BureauSchedules['inputPreview'];
  /** The Bureau's durable event history read, which {@link BureauSchedules.events} narrows to the schedule owner. */
  readonly eventHistory: Bureau['eventHistory'];
  /** The Bureau's durable event history subscription, which {@link BureauSchedules.subscribeEvents} narrows to the schedule owner. */
  readonly subscribeEventHistory: Bureau['subscribeEventHistory'];
};

/**
 * Build `bureau.schedules`. The schedule operations are the Bureau's own, unchanged; `events` and
 * `subscribeEvents` read the durable event history for the `schedule` owner of the id.
 */
export function createSchedules(dependencies: SchedulesDependencies): BureauSchedules {
  return {
    create: dependencies.create,
    get: dependencies.get,
    list: dependencies.list,
    pause: dependencies.pause,
    resume: dependencies.resume,
    cancel: dependencies.cancel,
    update: dependencies.update,
    agentName: dependencies.agentName,
    inputPreview: dependencies.inputPreview,
    events: (scheduleId, options) =>
      dependencies.eventHistory({ kind: 'schedule', id: scheduleId }, options),
    subscribeEvents: (scheduleId, listener, options) =>
      dependencies.subscribeEventHistory({ kind: 'schedule', id: scheduleId }, listener, options),
  };
}
