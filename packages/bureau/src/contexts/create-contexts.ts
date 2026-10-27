import type {
  BureauContexts,
  DurableEventHistoryRead,
  DurableEventHistorySubscribe,
} from '../types.ts';

/**
 * What {@link createContexts} composes `bureau.contexts` from: the Bureau's own context
 * implementations, which share its session store, run state, steering gates, and durable mailbox
 * and so are built where that state lives, and the durable event history the session owner kind is
 * read from.
 */
export type ContextsDependencies = {
  /** {@link BureauContexts.list}. */
  readonly list: BureauContexts['list'];
  /** {@link BureauContexts.get}. */
  readonly get: BureauContexts['get'];
  /** {@link BureauContexts.delete}. */
  readonly delete: BureauContexts['delete'];
  /** {@link BureauContexts.signal}. */
  readonly signal: BureauContexts['signal'];
  /** {@link BureauContexts.input}. */
  readonly input: BureauContexts['input'];
  /** {@link BureauContexts.inputsDeliveredBy}. */
  readonly inputsDeliveredBy: BureauContexts['inputsDeliveredBy'];
  /** {@link BureauContexts.steer}. */
  readonly steer: BureauContexts['steer'];
  /** {@link BureauContexts.steering}. */
  readonly steering: BureauContexts['steering'];
  /** {@link BureauContexts.fork}. */
  readonly fork: BureauContexts['fork'];
  /** The Bureau's durable event history read, which {@link BureauContexts.events} narrows to the session owner. */
  readonly eventHistory: DurableEventHistoryRead;
  /** The Bureau's durable event history subscription, which {@link BureauContexts.subscribeEvents} narrows to the session owner. */
  readonly subscribeEventHistory: DurableEventHistorySubscribe;
};

/**
 * Build `bureau.contexts`. The context operations are the Bureau's own, unchanged; `events` and
 * `subscribeEvents` read the durable event history for the `session` owner of the id. The run
 * owner's history stays on `eventHistory` and `subscribeEventHistory` until `tasks.events` replaces
 * it.
 */
export function createContexts(dependencies: ContextsDependencies): BureauContexts {
  return {
    list: dependencies.list,
    get: dependencies.get,
    delete: dependencies.delete,
    signal: dependencies.signal,
    input: dependencies.input,
    inputsDeliveredBy: dependencies.inputsDeliveredBy,
    steer: dependencies.steer,
    steering: dependencies.steering,
    fork: dependencies.fork,
    events: (contextId, options) =>
      dependencies.eventHistory({ kind: 'session', id: contextId }, options),
    subscribeEvents: (contextId, listener, options) =>
      dependencies.subscribeEventHistory({ kind: 'session', id: contextId }, listener, options),
  };
}
