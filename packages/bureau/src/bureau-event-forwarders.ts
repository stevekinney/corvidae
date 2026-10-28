/**
 * COR-1721 — the sources that reach the bureau emitter from outside it: diagnostics, the asset
 * service, the agent and workflow file catalogs, and the durable engine's missed-fire signal. Each
 * forwarder is a function of the source and a dispatch, so `createBureau` holds only the wiring and
 * each family is tested against the real forwarder.
 *
 * @module bureau-event-forwarders
 */

import { ScheduleMissedFireEvent } from '@lostgradient/weft';

import type { AssetEvent } from './assets/types';
import {
  AssetLifecycleEvent,
  BUREAU_ASSET_EVENT_KINDS,
  type BureauAssetEventKind,
  DefinitionsChangedEvent,
  type DefinitionSourceKind,
  DiagnosticEvent,
  ScheduleMissedEvent,
} from './events';
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
  source: DefinitionSourceKind,
  catalog: {
    onChange(
      listener: (change: {
        readonly added: readonly string[];
        readonly changed: readonly string[];
        readonly removed: readonly string[];
        readonly rejected: readonly string[];
      }) => void,
    ): () => void;
  },
  dispatch: (event: DefinitionsChangedEvent) => void,
): () => void {
  return catalog.onChange((change) => dispatch(new DefinitionsChangedEvent(source, change)));
}

/**
 * Forwards the durable engine's `schedule:missed-fire` as `schedule.missed`, once `getSchedule`
 * confirms the schedule is one this Bureau can read. A lookup that fails is diagnosed and the event
 * dropped, and nothing is dispatched once the returned function has stopped the forwarding, even
 * for a lookup already in flight.
 */
export function forwardMissedFires(
  engine: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  getSchedule: (scheduleId: string) => Promise<unknown>,
  dispatch: (event: ScheduleMissedEvent) => void,
  diagnose: DiagnosticSink,
): () => void {
  let stopped = false;
  const forward = async (missed: ScheduleMissedFireEvent): Promise<void> => {
    const { scheduleId, missedCount, windowStart, windowEnd } = missed;
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
    dispatch(new ScheduleMissedEvent(scheduleId, missedCount, windowStart, windowEnd));
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
