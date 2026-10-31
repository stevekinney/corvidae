/**
 * COR-1721 — the sources that reach the bureau emitter from outside it: diagnostics, the asset
 * service, the agent and workflow file catalogs, and the durable engine's missed-fire signal. Each
 * forwarder is a function of the source and a dispatch, so `createBureau` holds only the wiring and
 * each family is tested against the real forwarder.
 *
 * @module bureau-event-forwarders
 */

import { ScheduleMissedFireEvent } from '@lostgradient/weft';

import type { GovernedMemory } from '@lostgradient/memory';

import type { AssetEvent } from './assets/types';
import {
  AssetLifecycleEvent,
  BUREAU_ASSET_EVENT_KINDS,
  type BureauAssetEventKind,
  DefinitionsChangedEvent,
  type DefinitionCatalogKind,
  DiagnosticEvent,
  MemoryGovernanceEvent,
  ScheduleMissedEvent,
} from './events';
import { markEventSource } from './event-source';
import type { DiagnosticSink } from './types';

/** The Bureau's one diagnostic choke point; see {@link createDiagnosticDispatcher}. */
export interface DiagnosticDispatcher {
  /** Reports to the sink, then dispatches a {@link DiagnosticEvent} when it may. Never throws. */
  readonly diagnose: DiagnosticSink;
  /**
   * Reports to the sink only. For the event feed's own recorder, whose failure dispatching an event
   * would be recorded by the same failing feed.
   */
  readonly report: DiagnosticSink;
  /** Starts dispatching: every `diagnose` after this also dispatches, unless it is re-entrant. */
  bind(dispatch: (event: DiagnosticEvent) => void): void;
}

/**
 * Wraps `sink` so each diagnostic is also dispatched as a {@link DiagnosticEvent}. A call before
 * {@link DiagnosticDispatcher.bind}, and one made while a `diagnostic` event is being dispatched
 * (a listener that throws on it and is diagnosed in turn), reach the sink only, so no diagnostic
 * can recurse. A dispatch that throws is reported to the sink and never thrown to the caller,
 * because callers diagnose from inside their own `catch` blocks.
 */
export function createDiagnosticDispatcher(sink: DiagnosticSink): DiagnosticDispatcher {
  let dispatch: ((event: DiagnosticEvent) => void) | undefined;
  let dispatching = false;
  return {
    report: sink,
    diagnose(diagnostic) {
      sink(diagnostic);
      if (dispatch === undefined || dispatching) return;
      dispatching = true;
      try {
        dispatch(new DiagnosticEvent(diagnostic.level, diagnostic.scope));
      } catch (error) {
        sink({
          level: 'error',
          scope: 'events',
          message: '[bureau] A listener threw on a "diagnostic" event:',
          cause: error,
        });
      } finally {
        dispatching = false;
      }
    },
    bind(next) {
      dispatch = next;
    },
  };
}

/**
 * Records every event `source` emits into `feed`. Guarded (AB-96): the emitter walks its all-events
 * listeners unguarded, so a throw here would escape whichever dispatch was in flight. A failure goes
 * to `report`, which must be sink-only: a diagnostic event would be recorded by the same feed and
 * fail again.
 */
export function subscribeEventFeed(
  source: { toObservable(): { subscribe(next: (event: Event) => void): { unsubscribe(): void } } },
  feed: { publish(event: unknown): unknown },
  report: DiagnosticSink,
): { unsubscribe(): void } {
  return source.toObservable().subscribe((event: Event) => {
    try {
      feed.publish(event);
    } catch (error) {
      report({
        level: 'error',
        scope: 'event-feed',
        message: `[bureau] event feed threw recording a "${event.type}" event:`,
        cause: error,
      });
    }
  });
}

const FORWARDED_ASSET_KINDS: ReadonlySet<string> = new Set(BUREAU_ASSET_EVENT_KINDS);

/**
 * Forwards the four {@link BureauAssetEventKind}s the asset service delivers to its subscribers
 * onto the bureau emitter, synchronously, in the asset service's own order. Returns the
 * unsubscribe.
 */
export function forwardAssetEvents(
  assets: { subscribe(listener: (event: AssetEvent) => void): () => void },
  dispatch: (event: AssetLifecycleEvent) => void,
): () => void {
  return assets.subscribe((event) => {
    if (!FORWARDED_ASSET_KINDS.has(event.type)) return;
    dispatch(new AssetLifecycleEvent(event.type as BureauAssetEventKind, event));
  });
}

/** Forwards a file catalog's `onChange` reports as `definitions.changed`. Returns the unsubscribe. */
export function forwardDefinitionChanges(
  catalog: DefinitionCatalogKind,
  files: {
    onChange(
      listener: (change: {
        readonly added: readonly string[];
        readonly changed: readonly string[];
        readonly removed: readonly string[];
        readonly rejected: readonly string[];
        readonly source?: string | undefined;
      }) => void,
    ): () => void;
  },
  dispatch: (event: DefinitionsChangedEvent) => void,
): () => void {
  return files.onChange((change) => {
    const event = new DefinitionsChangedEvent(catalog, change);
    // COR-1890: a change a plugin's own tool caused names the plugin.
    dispatch(change.source === undefined ? event : markEventSource(event, change.source));
  });
}

/** Where {@link forwardMissedFires} listens: the engine itself, or a {@link bufferMissedFires} view. */
export interface MissedFireSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** A {@link MissedFireSource} that holds what the engine reported before anyone listened. */
export type MissedFireBuffer = MissedFireSource;

/**
 * Starts listening for the engine's `schedule:missed-fire` signal now and replays it to the first
 * listener later. Weft's poller starts inside `Engine.create`, and the Bureau forwards the signal
 * only once the rest of its composition has finished (memory initialization is awaited in
 * between), so an overdue schedule that the first poll finds in that window would otherwise be
 * reported to nobody. The first listener added receives every held event, in order, before any
 * live one; a later listener receives live events only. The engine owns the subscription, which ends
 * with it.
 */
export function bufferMissedFires(
  engine: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
): MissedFireBuffer {
  let held: ScheduleMissedFireEvent[] | undefined = [];
  const listeners = new Set<(event: Event) => void>();
  const onEngine = (event: Event): void => {
    if (!(event instanceof ScheduleMissedFireEvent)) return;
    if (held !== undefined) {
      held.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
  };
  engine.addEventListener(ScheduleMissedFireEvent.type, onEngine);
  return {
    addEventListener(_type, listener) {
      listeners.add(listener);
      const replay = held;
      held = undefined;
      for (const event of replay ?? []) listener(event);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
}

/**
 * Forwards the durable engine's `schedule:missed-fire` as `schedule.missed`, once `getSchedule`
 * confirms the schedule is one this Bureau can read. A lookup that fails is diagnosed and the event
 * dropped, and nothing is dispatched once the returned function has stopped the forwarding, even
 * for a lookup already in flight.
 */
export function forwardMissedFires(
  engine: MissedFireSource,
  getSchedule: (scheduleId: string) => Promise<unknown>,
  dispatch: (event: ScheduleMissedEvent) => void,
  diagnose: DiagnosticSink,
): () => void {
  let stopped = false;
  const forward = async (missed: ScheduleMissedFireEvent): Promise<void> => {
    const { scheduleId, missedCount, windowStart, windowEnd, reason } = missed;
    let schedule: unknown;
    try {
      schedule = await getSchedule(scheduleId);
    } catch (error) {
      if (stopped) return;
      diagnose({
        level: 'warn',
        scope: 'schedules',
        message: `[bureau] Could not read schedule "${scheduleId}" to report its missed occurrences:`,
        cause: error,
      });
      return;
    }
    if (stopped || schedule === null || schedule === undefined) return;
    dispatch(new ScheduleMissedEvent(scheduleId, missedCount, windowStart, windowEnd, reason));
  };
  const listener = (event: Event): void => {
    if (!(event instanceof ScheduleMissedFireEvent)) return;
    forward(event).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'events',
        message: `[bureau] Dispatching "schedule.missed" for schedule "${event.scheduleId}" threw:`,
        cause: error,
      });
    });
  };
  engine.addEventListener(ScheduleMissedFireEvent.type, listener);
  return () => {
    stopped = true;
    engine.removeEventListener(ScheduleMissedFireEvent.type, listener);
  };
}

/**
 * Forwards each notification `memory` hands its subscribers as a `memory.governance` event, in the
 * order memory delivers them, and returns the unsubscribe. Memory reports a listener that throws
 * with `console.error` and moves on; a dispatch that throws here is diagnosed instead, so the host's
 * own sink hears it.
 */
export function forwardMemoryGovernance(
  memory: Pick<GovernedMemory, 'subscribe'>,
  dispatch: (event: MemoryGovernanceEvent) => void,
  diagnose: DiagnosticSink,
): () => void {
  return memory.subscribe((notification) => {
    try {
      dispatch(new MemoryGovernanceEvent(notification));
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'events',
        message: `[bureau] Dispatching "memory.governance" for "${notification.type}" threw:`,
        cause: error,
      });
    }
  });
}
