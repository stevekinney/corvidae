import { describe, expect, test } from 'bun:test';

import type { ServerFrame } from '../types.ts';
import { createAgUiLiveFeedRegistry } from './ag-ui-live-feed.ts';

function frame(runId: string, content: string): ServerFrame {
  return {
    type: 'stream:text-delta',
    runId,
    content,
    accumulated: content,
    runSeq: 1,
  };
}

describe('AG-UI live feed', () => {
  test('retains a bounded suffix and shares one producer across attachments', () => {
    const listeners = new Set<(value: ServerFrame) => void>();
    const registry = createAgUiLiveFeedRegistry((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, 2);
    const first = registry.forRun('run-1');
    const second = registry.forRun('run-1');
    expect(first).toBe(second);
    expect(listeners).toHaveLength(1);

    listeners.forEach((listener) => listener(frame('run-1', 'one')));
    listeners.forEach((listener) => listener(frame('run-1', 'two')));
    const opening = first.subscribe(() => undefined);
    expect(opening.opening).toHaveLength(2);
    expect(opening.opening[0]?.cursor).toMatch(/^agui-live-v1\.[^.]+\.[^.]+\.1$/);
    expect(opening.opening[1]?.cursor).toMatch(/\.2$/);
    opening.unsubscribe();

    const resumed = first.subscribe(() => undefined, opening.opening[0]?.cursor);
    expect(resumed.resumed).toBe(true);
    expect(resumed.opening).toHaveLength(1);
    resumed.unsubscribe();

    const foreign = first.subscribe(() => undefined, 'agui-live-v1.foreign.epoch.1');
    expect(foreign.resumed).toBe(false);
    foreign.unsubscribe();

    listeners.forEach((listener) => listener(frame('run-1', 'three')));
    const evicted = first.subscribe(
      () => undefined,
      opening.opening[0]?.cursor.replace(/\.1$/, '.0'),
    );
    expect(evicted.resumed).toBe(false);
    evicted.unsubscribe();

    first.dispose();
    expect(listeners).toHaveLength(0);
  });

  test('does not deliver another run to the feed', () => {
    const listeners = new Set<(value: ServerFrame) => void>();
    const registry = createAgUiLiveFeedRegistry((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, 2);
    const feed = registry.forRun('run-1');
    listeners.forEach((listener) => listener(frame('run-2', 'other')));
    expect(feed.subscribe(() => undefined).opening).toHaveLength(0);
    registry.dispose();
  });

  test('bootstraps a recorded event that was emitted before the first attachment', () => {
    const listeners = new Set<(value: ServerFrame) => void>();
    const registry = createAgUiLiveFeedRegistry((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, 4);
    const feed = registry.forRun('run-1');
    feed.bootstrap([{ sequence: 7, event: 'step.started', detail: { step: 0 }, timestamp: 1 }]);
    const opening = feed.subscribe(() => undefined);
    expect(opening.opening).toHaveLength(1);
    expect(opening.opening[0]?.frame).toMatchObject({ event: 'step.started', sequence: 7 });
    expect(opening.opening[0]?.cursor).toMatch(/\.1$/);

    listeners.forEach((listener) =>
      listener({
        type: 'event',
        runId: 'run-1',
        event: 'step.started',
        detail: { step: 0 },
        sequence: 7,
        timestamp: 1,
        runSeq: 1,
      }),
    );
    expect(feed.subscribe(() => undefined).opening).toHaveLength(1);
    registry.dispose();
  });
});
