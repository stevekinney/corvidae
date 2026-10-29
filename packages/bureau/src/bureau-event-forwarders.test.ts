/**
 * COR-1721 — the forwarders that put diagnostics, asset events, file-catalog changes, and missed
 * schedule fires on the bureau emitter, run against a real emitter and the real event feed.
 */
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { ScheduleMissedFireEvent } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { AssetEvent } from './assets/types';
import { createBureauEventFeed } from './bureau-event-feed';
import {
  bufferMissedFires,
  createDiagnosticDispatcher,
  forwardAssetEvents,
  forwardDefinitionChanges,
  forwardMissedFires,
  subscribeEventFeed,
} from './bureau-event-forwarders';
import {
  AssetLifecycleEvent,
  type BureauEventMap,
  DefinitionsChangedEvent,
  DiagnosticEvent,
  RunRegisteredEvent,
  ScheduleMissedEvent,
} from './events';
import type { BureauDiagnostic } from './types';

function diagnosticHarness() {
  const sunk: BureauDiagnostic[] = [];
  const emitter = new CompletableEventTarget<BureauEventMap>();
  const dispatcher = createDiagnosticDispatcher((diagnostic) => sunk.push(diagnostic));
  const dispatched: DiagnosticEvent[] = [];
  emitter.addEventListener(DiagnosticEvent.type, (event) => dispatched.push(event));
  return { sunk, emitter, dispatcher, dispatched };
}

const warning: BureauDiagnostic = {
  level: 'warn',
  scope: 'settings',
  message: 'MESSAGE-not-for-the-wire',
  cause: new Error('CAUSE-not-for-the-wire'),
};

describe('the diagnostic dispatcher', () => {
  it('reaches the sink only, and does not throw, before an emitter is bound', () => {
    const { sunk, dispatcher, dispatched } = diagnosticHarness();

    expect(() => dispatcher.diagnose(warning)).not.toThrow();

    expect(sunk).toEqual([warning]);
    expect(dispatched).toEqual([]);
  });

  it('dispatches each diagnostic once bound, with its level and scope and nothing else', () => {
    const { sunk, emitter, dispatcher, dispatched } = diagnosticHarness();
    dispatcher.bind((event) => emitter.dispatch(event));

    dispatcher.diagnose(warning);

    expect(sunk).toEqual([warning]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBeInstanceOf(DiagnosticEvent);
    expect({ level: dispatched[0]?.level, scope: dispatched[0]?.scope }).toEqual({
      level: 'warn',
      scope: 'settings',
    });
    expect(JSON.stringify(dispatched[0])).not.toContain('not-for-the-wire');
  });

  it('sends a diagnostic raised while a diagnostic event is dispatched to the sink only', () => {
    const { sunk, emitter, dispatcher, dispatched } = diagnosticHarness();
    dispatcher.bind((event) => emitter.dispatch(event));
    // A listener that reports a failure of its own on every diagnostic, as `onEvent`'s does.
    emitter.addEventListener(DiagnosticEvent.type, () => {
      dispatcher.diagnose({ level: 'error', scope: 'events', message: 'listener failed' });
    });

    dispatcher.diagnose(warning);

    expect(sunk.map((diagnostic) => diagnostic.scope)).toEqual(['settings', 'events']);
    expect(dispatched.map((event) => event.scope)).toEqual(['settings']);
    // The flag is cleared afterwards, so the next diagnostic dispatches again.
    dispatcher.diagnose(warning);
    expect(dispatched.map((event) => event.scope)).toEqual(['settings', 'settings']);
  });

  it('reports a dispatch that throws to the sink and never throws to its caller', () => {
    const { sunk, dispatcher } = diagnosticHarness();
    dispatcher.bind(() => {
      throw new Error('an all-events listener threw');
    });

    expect(() => dispatcher.diagnose(warning)).not.toThrow();

    expect(sunk.map((diagnostic) => diagnostic.scope)).toEqual(['settings', 'events']);
  });
});

describe('the event feed recorder', () => {
  it('reports each failure of a feed that always throws exactly once, and dispatches no diagnostic', () => {
    const { sunk, emitter, dispatcher, dispatched } = diagnosticHarness();
    let publishes = 0;
    const subscription = subscribeEventFeed(
      emitter,
      {
        publish() {
          publishes += 1;
          throw new Error('the feed is broken');
        },
      },
      dispatcher.report,
    );
    dispatcher.bind((event) => emitter.dispatch(event));

    emitter.dispatch(new RunRegisteredEvent('run-1'));
    emitter.dispatch(new RunRegisteredEvent('run-2'));
    // A diagnostic raised elsewhere is dispatched, and the feed's failure to record it is again
    // reported once and dispatched as nothing.
    dispatcher.diagnose(warning);

    expect(publishes).toBe(3);
    expect(sunk.map((diagnostic) => diagnostic.scope)).toEqual([
      'event-feed',
      'event-feed',
      'settings',
      'event-feed',
    ]);
    expect(dispatched.map((event) => event.scope)).toEqual(['settings']);
    subscription.unsubscribe();
  });

  it('records a diagnostic into the real feed with its level and scope only', () => {
    const { emitter, dispatcher } = diagnosticHarness();
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', now: () => 7 });
    const subscription = subscribeEventFeed(emitter, feed, dispatcher.report);
    dispatcher.bind((event) => emitter.dispatch(event));

    dispatcher.diagnose(warning);
    const appended = feed.publish(new RunRegisteredEvent('run-after'));

    // The diagnostic took sequence 0, so the next event is 1.
    expect(appended?.sequence).toBe(1);
    subscription.unsubscribe();
    feed.dispose();
  });
});

function assetEvent(event: Partial<AssetEvent> & Pick<AssetEvent, 'type'>): AssetEvent {
  return { at: '2026-10-28T00:00:00.000Z', sequence: 1, ...event };
}

describe('the asset forwarder', () => {
  it('forwards the four published asset kinds with their fields and nothing else', () => {
    let deliver: (event: AssetEvent) => void = () => undefined;
    let unsubscribed = false;
    const forwarded: AssetLifecycleEvent[] = [];
    const stop = forwardAssetEvents(
      {
        subscribe(listener) {
          deliver = listener;
          return () => {
            unsubscribed = true;
          };
        },
      },
      (event) => forwarded.push(event),
    );

    deliver(assetEvent({ type: 'asset.upload.started', uploadId: 'upload-1', principal: 'alice' }));
    deliver(assetEvent({ type: 'asset.available', assetId: 'asset-1' }));
    deliver(assetEvent({ type: 'asset.upload.purged', sequence: 2, uploadId: 'upload-1' }));
    deliver(assetEvent({ type: 'asset.blob.purged', sequence: 3, digest: 'sha256:abc' }));
    deliver(
      assetEvent({
        type: 'asset.expired',
        sequence: 4,
        assetId: 'asset-1',
        revision: 3,
        state: 'expired',
        principal: 'alice',
      }),
    );
    stop();

    expect(forwarded.map((event) => event.type)).toEqual([
      'asset.upload.started',
      'asset.upload.purged',
      'asset.blob.purged',
      'asset.expired',
    ]);
    expect(forwarded[3]).toMatchObject({
      sequence: 4,
      at: '2026-10-28T00:00:00.000Z',
      assetId: 'asset-1',
      revision: 3,
      state: 'expired',
      principal: 'alice',
    });
    expect(unsubscribed).toBe(true);
  });
});

describe('the definition change forwarder', () => {
  it('dispatches each catalog change with its source and identifier lists', () => {
    let notify: (change: {
      added: string[];
      changed: string[];
      removed: string[];
      rejected: string[];
    }) => void = () => undefined;
    const forwarded: DefinitionsChangedEvent[] = [];
    forwardDefinitionChanges(
      'workflows',
      {
        onChange(listener) {
          notify = listener;
          return () => undefined;
        },
      },
      (event) => forwarded.push(event),
    );

    notify({ added: ['a'], changed: ['b'], removed: ['c'], rejected: ['b'] });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      type: 'definitions.changed',
      source: 'workflows',
      added: ['a'],
      changed: ['b'],
      removed: ['c'],
      rejected: ['b'],
    });
  });
});

describe('the missed-fire buffer', () => {
  it('replays what the engine reported before the first listener, then forwards live events', () => {
    const engine = new EventTarget();
    const buffer = bufferMissedFires(engine);
    engine.dispatchEvent(new ScheduleMissedFireEvent('early-1', 1, 0, 1));
    engine.dispatchEvent(new Event('unrelated'));
    engine.dispatchEvent(new ScheduleMissedFireEvent('early-2', 2, 0, 1));

    const first: string[] = [];
    buffer.addEventListener(ScheduleMissedFireEvent.type, (event) => {
      if (event instanceof ScheduleMissedFireEvent) first.push(event.scheduleId);
    });
    expect(first).toEqual(['early-1', 'early-2']);

    engine.dispatchEvent(new ScheduleMissedFireEvent('live', 1, 0, 1));
    const second: string[] = [];
    buffer.addEventListener(ScheduleMissedFireEvent.type, (event) => {
      if (event instanceof ScheduleMissedFireEvent) second.push(event.scheduleId);
    });
    engine.dispatchEvent(new ScheduleMissedFireEvent('later', 1, 0, 1));

    expect(first).toEqual(['early-1', 'early-2', 'live', 'later']);
    expect(second).toEqual(['later']);
  });
});

describe('the missed-fire forwarder', () => {
  it('dispatches only for a schedule the Bureau can read, and nothing once stopped', async () => {
    const engine = new EventTarget();
    const forwarded: ScheduleMissedEvent[] = [];
    const lookups: string[] = [];
    const sunk: BureauDiagnostic[] = [];
    const stop = forwardMissedFires(
      engine,
      async (scheduleId) => {
        lookups.push(scheduleId);
        if (scheduleId === 'broken') throw new Error('storage unavailable');
        return scheduleId === 'mine' ? { id: 'mine' } : null;
      },
      (event) => forwarded.push(event),
      (diagnostic) => sunk.push(diagnostic),
    );

    engine.dispatchEvent(new ScheduleMissedFireEvent('foreign', 2, 100, 200));
    engine.dispatchEvent(new ScheduleMissedFireEvent('broken', 1, 100, 200));
    engine.dispatchEvent(new ScheduleMissedFireEvent('mine', 3, 1_000, 4_000));
    await waitUntil(() => forwarded.length === 1 && sunk.length === 1);

    expect(forwarded[0]).toBeInstanceOf(ScheduleMissedEvent);
    expect(forwarded[0]).toMatchObject({
      type: 'schedule.missed',
      scheduleId: 'mine',
      missedCount: 3,
      windowStart: 1_000,
      windowEnd: 4_000,
    });
    expect(sunk[0]).toMatchObject({ level: 'warn', scope: 'schedules' });

    stop();
    engine.dispatchEvent(new ScheduleMissedFireEvent('mine', 1, 5_000, 6_000));
    expect(lookups).toEqual(['foreign', 'broken', 'mine']);
  });

  it('drops a lookup still in flight when it is stopped', async () => {
    const engine = new EventTarget();
    const lookup = Promise.withResolvers<unknown>();
    let looked = false;
    const forwarded: ScheduleMissedEvent[] = [];
    const stop = forwardMissedFires(
      engine,
      () => {
        looked = true;
        return lookup.promise;
      },
      (event) => forwarded.push(event),
      () => undefined,
    );

    engine.dispatchEvent(new ScheduleMissedFireEvent('mine', 1, 0, 1));
    expect(looked).toBe(true);
    stop();
    lookup.resolve({ id: 'mine' });
    // The forwarder awaited this promise first, so its continuation has run once this one resumes.
    await lookup.promise;

    expect(forwarded).toEqual([]);
  });
});
