import { describe, expect, test } from 'bun:test';
import { EventType } from '@ag-ui/core';

import type { RunEventRecord, ServerFrame } from '../types.ts';
import { createAgUiLiveFeedRegistry, type AgUiLiveUpdate } from './ag-ui-live-feed.ts';

const context = { nativeRunId: 'run-1', sessionId: 'thread', now: () => 1 };
const record = (sequence: number, event: string, detail: unknown): RunEventRecord => ({
  sequence,
  event,
  detail,
  timestamp: 1,
  runId: 'run-1',
});
function fixture(
  retain = 8,
  recorded: () => RunEventRecord[] = () => [record(1, 'step.started', { step: 0 })],
) {
  const listeners = new Set<(frame: ServerFrame) => void>();
  const registry = createAgUiLiveFeedRegistry((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, retain);
  const feed = registry.forRun('run-1', context, recorded);
  const emit = (value: ServerFrame): void => {
    for (const listener of listeners) listener(value);
  };
  return {
    feed,
    registry,
    listeners,
    emit,
    event: (sequence: number, name: string, detail: unknown) =>
      emit({ ...record(sequence, name, detail), type: 'event', runSeq: sequence }),
    delta: (content: string, accumulated = content) =>
      emit({ type: 'stream:text-delta', runId: 'run-1', content, accumulated, runSeq: 2 }),
  };
}

describe('shared AG-UI projection producer', () => {
  test('allocates a distinct cursor per output and replays after a cut inside one source transition', () => {
    const { feed, event, registry, listeners } = fixture();
    const updates: AgUiLiveUpdate[] = [];
    const first = feed.subscribe((update) => updates.push(update), undefined);
    expect(first.opening.map((entry) => entry.event.type)).toEqual([EventType.STEP_STARTED]);
    expect(first.opening[0]?.cursor).toEndWith('.1');
    event(2, 'generate.completed', { step: 0, response: { content: 'Hello' } });
    const output = updates.flatMap((update) => ('envelope' in update ? [update.envelope] : []));
    expect(output.map((entry) => entry.event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(output.map((entry) => entry.sequence)).toEqual([2, 3, 4]);
    first.unsubscribe();
    expect(listeners.size).toBe(1);
    const second = feed.subscribe(() => undefined, output[0]!.cursor);
    expect(second.resumed).toBe(true);
    expect(second.opening).toEqual(output.slice(1));
    second.unsubscribe();
    event(3, 'run.completed', {});
    expect(listeners.size).toBe(0);
    registry.dispose();
  });

  test('zero-output input does not advance a cursor; another run never enters the projection', () => {
    const { feed, event, emit, registry } = fixture();
    const first = feed.subscribe(() => undefined, undefined);
    event(2, 'unknown', {});
    emit({
      type: 'stream:text-delta',
      runId: 'other',
      content: 'secret',
      accumulated: 'secret',
      runSeq: 1,
    });
    const next = feed.subscribe(() => undefined, first.cursor);
    expect(next.cursor).toBe(first.cursor);
    expect(next.resumed).toBe(true);
    expect(next.opening).toEqual([]);
    registry.dispose();
  });

  test('retention eviction preserves the full accumulated checkpoint and validates cursor identity', () => {
    const { feed, delta, registry } = fixture(2);
    const initial = feed.subscribe(() => undefined, undefined);
    initial.unsubscribe();
    delta('a');
    delta('b', 'ab');
    delta('c', 'abc');
    const invalid = [
      undefined,
      initial.cursor,
      initial.cursor.replace(/\.1$/, '.999'),
      initial.cursor.replace(/\.1$/, '.9007199254740992'),
      initial.cursor.replace(/\.1$/, '.01'),
      initial.cursor.replace('cnVuLTE', 'b3RoZXI'),
      'agui-live-v1.invalid',
    ];
    for (const cursor of invalid) {
      const fallback = feed.subscribe(() => undefined, cursor);
      expect(fallback.resumed).toBe(false);
      expect(fallback.opening.map((entry) => entry.event.type)).toEqual([
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
      ]);
      expect(fallback.opening.at(-1)?.event).toMatchObject({ delta: 'abc' });
      expect(fallback.opening.at(-1)?.cursor).toBe(fallback.cursor);
      fallback.unsubscribe();
    }
    registry.dispose();
  });

  test('one subscription and projector survive independent cancellation and release on removal', () => {
    const { feed, registry, delta, listeners } = fixture();
    expect(registry.forRun('run-1', context, () => [])).toBe(feed);
    const first: AgUiLiveUpdate[] = [];
    const second: AgUiLiveUpdate[] = [];
    const a = feed.subscribe((value) => first.push(value), undefined);
    feed.subscribe((value) => second.push(value), undefined);
    a.unsubscribe();
    delta('a');
    expect(first).toEqual([]);
    expect(second).toHaveLength(2);
    expect(listeners.size).toBe(1);
    registry.remove('run-1');
    expect(second.at(-1)).toEqual({ removed: true });
    expect(listeners.size).toBe(0);
  });

  test('subscribes before the history read and deduplicates by source sequence', () => {
    const listeners = new Set<(frame: ServerFrame) => void>();
    const registry = createAgUiLiveFeedRegistry((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, 8);
    const feed = registry.forRun('run-1', context, () => {
      for (const listener of listeners)
        listener({ type: 'event', ...record(1, 'step.started', { step: 0 }), runSeq: 1 });
      for (const listener of listeners)
        listener({
          type: 'stream:text-delta',
          runId: 'run-1',
          content: 'a',
          accumulated: 'a',
          runSeq: 2,
        });
      return [record(1, 'step.started', { step: 0 })];
    });
    const opening = feed.subscribe(() => undefined, undefined, new Set(), true);
    expect(opening.opening.map((entry) => entry.event.type)).toEqual([
      EventType.STEP_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(opening.cursor).toEndWith('.3');
    registry.dispose();
    expect(listeners.size).toBe(0);
  });
});

test('an attachment created during notification receives only tail beyond its atomic cut', () => {
  const { feed, event, registry } = fixture();
  const tail: AgUiLiveUpdate[] = [];
  let captured: ReturnType<typeof feed.subscribe> | undefined;
  feed.subscribe((update) => {
    if ('envelope' in update && captured === undefined)
      captured = feed.subscribe((value) => tail.push(value), undefined);
  }, undefined);
  event(2, 'generate.completed', { step: 0, response: { content: 'hello' } });
  expect(captured?.cursor).toEndWith('.4');
  expect(captured?.opening.map((entry) => entry.event.type)).toEqual([
    EventType.STEP_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
  ]);
  expect(tail).toEqual([]);
  event(3, 'step.completed', { step: 0, content: 'hello' });
  expect(tail).toHaveLength(1);
  registry.dispose();
});

test('a pending history read reserves the producer through native settlement', () => {
  const { feed, event, listeners, registry } = fixture();
  const release = feed.reserve();
  event(2, 'generate.completed', { step: 0, response: { content: 'hello' } });
  event(3, 'run.completed', {});
  expect(listeners.size).toBe(1);
  const attached = feed.subscribe(() => undefined, undefined, new Set(), true);
  release();
  expect(attached.terminal?.outcome).toBe('completed');
  expect(
    attached.opening.filter((entry) => entry.event.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toHaveLength(1);
  attached.unsubscribe();
  expect(listeners.size).toBe(0);
  registry.dispose();
});

test('a terminal frame buffered during bootstrap remains available to the first attachment', () => {
  const listeners = new Set<(frame: ServerFrame) => void>();
  const registry = createAgUiLiveFeedRegistry((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, 8);
  const feed = registry.forRun('run-1', context, () => {
    for (const listener of listeners)
      listener({ type: 'event', ...record(2, 'run.completed', {}), runSeq: 2 });
    return [record(1, 'step.started', { step: 0 })];
  });
  const attached = feed.subscribe(() => undefined, undefined, new Set(), true);
  expect(attached.removed).toBe(false);
  expect(attached.terminal?.outcome).toBe('completed');
  expect(attached.opening.map((entry) => entry.event.type)).toEqual([
    EventType.STEP_STARTED,
    EventType.STEP_FINISHED,
  ]);
  attached.unsubscribe();
  expect(listeners.size).toBe(0);
  registry.dispose();
});
