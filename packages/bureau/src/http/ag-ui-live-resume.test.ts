import { expect, test } from 'bun:test';
import { EventType } from '@ag-ui/core';
import { waitUntil } from '@lostgradient/testing/wait-until';
import type { ServerFrame } from '../types.ts';
import { savesSessionAs } from '../test/session-input-fixtures.ts';
import {
  attachRunRequest,
  openHarness,
  runAgentInput,
  startRequest,
  type HarnessOptions,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, FrameReader } from './ag-ui-stream.test-support.ts';

const script = [
  { kind: 'block' as const, barrier: 'hold' },
  { kind: 'respond' as const, response: { content: 'Hello world', toolCalls: [] } },
];
function attach(runId: string, cursor?: string): Request {
  const request = attachRunRequest(runId);
  if (cursor !== undefined) request.headers.set('Last-Event-ID', cursor);
  return request;
}

async function setup(size = 32, onDiagnostic?: HarnessOptions['onDiagnostic']) {
  const harness = await openHarness({
    script,
    agUi: { liveBufferSize: size },
    storage: 'sqlite',
    seamStorage: true,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
  const listeners = new Set<(frame: ServerFrame) => void>();
  const original = harness.bureau.frames.bind(harness.bureau);
  harness.bureau.frames = (listener) => {
    listeners.add(listener);
    const stop = original(listener);
    return () => {
      listeners.delete(listener);
      stop();
    };
  };
  const starter = new FrameReader(await harness.handler(startRequest(runAgentInput())));
  await starter.until(EventType.STEP_STARTED);
  await harness.generate.reached('hold');
  const runId = String(bureauMetadata(starter.received[0]!.event)['runId']);
  const cursor = starter.received.at(-1)!.id!;
  const delta = (content: string, accumulated: string) => {
    for (const listener of listeners)
      listener({ type: 'stream:text-delta', runId, content, accumulated, runSeq: 999 });
  };
  return { ...harness, listeners, starter, runId, cursor, delta };
}

test('real paused-run bootstrap emits an opening cursor, with one source shared across attaches', async () => {
  const h = await setup();
  try {
    const freshMount = h.remount();
    const reader = new FrameReader(await freshMount(attach(h.runId)));
    await reader.until(EventType.STEP_STARTED);
    expect(reader.received.at(-1)!.id).toMatch(/^agui-live-v1\./);
    expect(h.listeners.size).toBe(2); // one per mount, never one per attachment
    const another = new FrameReader(await freshMount(attach(h.runId)));
    await another.until(EventType.STEP_STARTED);
    expect(h.listeners.size).toBe(2);
    await reader.cancel();
    await another.cancel();
    await h.starter.cancel();
    expect(h.listeners.size).toBe(2);
    h.generate.release('hold');
    await h.bureau.tasks.wait(h.runId);
    await waitUntil(() => h.listeners.size === 0, { message: 'settled producers released' });
  } finally {
    await h.dispose();
  }
});

test('disconnect between two outputs of one delta replays only the missing projected event', async () => {
  const h = await setup();
  try {
    await h.starter.cancel();
    h.delta('Hello', 'Hello');
    const first = new FrameReader(await h.handler(attach(h.runId, h.cursor)));
    await first.until(EventType.TEXT_MESSAGE_START);
    const cursor = first.received.at(-1)!.id!;
    expect(cursor).not.toBe(h.cursor);
    expect(first.received.some((entry) => entry.event.type === EventType.MESSAGES_SNAPSHOT)).toBe(
      false,
    );
    await first.cancel();
    const second = new FrameReader(await h.handler(attach(h.runId, cursor)));
    await second.until(EventType.TEXT_MESSAGE_CONTENT);
    expect(
      second.received.filter((entry) => entry.event.type === EventType.TEXT_MESSAGE_START),
    ).toEqual([]);
    expect(second.received.at(-1)!.event).toMatchObject({ delta: 'Hello' });
    h.generate.release('hold');
    await second.rest();
    const deltas = second.received.flatMap((entry) =>
      entry.event.type === EventType.TEXT_MESSAGE_CONTENT ? [entry.event.delta] : [],
    );
    expect(deltas.join('')).toBe('Hello world');
    const terminal = second.received.at(-1)!;
    expect(terminal.event.type).toBe(EventType.RUN_FINISHED);
    expect(terminal.id).toBe(String(bureauMetadata(terminal.event)['cursor']));
    expect(terminal.id).not.toMatch(/^agui-live-v1\./);
  } finally {
    await h.dispose();
  }
});

test('a delta crossing the actual session read appears once in the snapshot checkpoint and subsequent tail', async () => {
  const h = await setup();
  try {
    const original = h.bureau.contexts.get.bind(h.bureau.contexts);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.bureau.contexts.get = async (...input) => {
      const value = await original(...input);
      entered.resolve();
      await release.promise;
      return value;
    };
    const response = h.handler(attach(h.runId));
    await entered.promise;
    h.delta('Hello', 'Hello');
    release.resolve();
    const reader = new FrameReader(await response);
    await reader.until(EventType.TEXT_MESSAGE_CONTENT);
    expect(reader.received.at(-1)!.event).toMatchObject({ delta: 'Hello' });
    const cut = reader.received.at(-1)!.id!;
    h.delta(' world', 'Hello world');
    await reader.until(EventType.TEXT_MESSAGE_CONTENT);
    expect(reader.received.at(-1)!.id).not.toBe(cut);
    expect(
      reader.received
        .filter((entry) => entry.event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((entry) => (entry.event as { delta: string }).delta),
    ).toEqual(['Hello', ' world']);
    h.bureau.contexts.get = original;
    h.generate.release('hold');
    await reader.rest();
    await h.starter.rest();
  } finally {
    await h.dispose();
  }
});

test('evicted, malformed, foreign, and future cursors restore the accumulated step with HTTP 200', async () => {
  const h = await setup(2);
  try {
    await h.starter.cancel();
    h.delta('H', 'H');
    h.delta('e', 'He');
    h.delta('llo', 'Hello');
    const cursors = [
      h.cursor,
      'malformed',
      h.cursor.replace('agui-live-v1.', 'agui-live-v1.foreign.'),
      h.cursor.replace(/\.\d+$/, '.999999'),
    ];
    for (const cursor of cursors) {
      const response = await h.handler(attach(h.runId, cursor));
      expect(response.status).toBe(200);
      const reader = new FrameReader(response);
      await reader.until(EventType.TEXT_MESSAGE_CONTENT);
      expect(
        reader.received.filter((entry) => entry.event.type === EventType.MESSAGES_SNAPSHOT),
      ).toHaveLength(1);
      expect(reader.received.at(-1)!.event).toMatchObject({ delta: 'Hello' });
      await reader.cancel();
    }
    expect(h.listeners.size).toBe(1);
  } finally {
    await h.dispose();
  }
});

for (const outcome of ['completed', 'aborted'] as const) {
  test(`an invalid cursor retains terminal ${outcome} output while the real session write is held`, async () => {
    const h = await setup(2);
    const held = h.seam!.holdWrite(savesSessionAs(outcome));
    const opening = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    try {
      h.delta('Hello', 'Hello');
      await h.starter.until(EventType.TEXT_MESSAGE_CONTENT);
      await h.starter.cancel();
      const events = h.bureau.tasks.events.bind(h.bureau.tasks);
      const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      let calls = 0;
      h.bureau.tasks.events = async (...arguments_) => {
        const index = calls++;
        if (index < opening.length) {
          reads[index]!.resolve();
          await opening[index]!.promise;
        }
        return events(...arguments_);
      };
      const before = new FrameReader(await h.handler(attach(h.runId, 'agui-live-v1.foreign')));
      await reads[0]!.promise;
      const after = new FrameReader(await h.handler(attach(h.runId, 'agui-live-v1.foreign')));
      await reads[1]!.promise;
      if (outcome === 'completed') h.generate.release('hold');
      else void h.bureau.tasks.cancel(h.runId);
      await held.reached;
      const rejected = new FrameReader(await h.handler(attach(h.runId, 'malformed')));
      await rejected.rest();
      expect(rejected.received.map(({ event }) => event)).toMatchObject([
        { type: EventType.RUN_ERROR, code: 'RUN_NOT_FOUND' },
      ]);
      opening[0]!.resolve();
      await before.rest();
      const contents = before.received.flatMap(({ event }) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT
          ? [event.delta]
          : event.type === EventType.MESSAGES_SNAPSHOT
            ? event.messages.flatMap((row) =>
                row.role === 'assistant' && typeof row.content === 'string' ? [row.content] : [],
              )
            : [],
      );
      expect(contents.join('')).toBe(outcome === 'completed' ? 'Hello world' : 'Hello');
      expect(before.received.at(-1)?.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: outcome === 'completed' ? 'success' : 'cancelled' },
      });
      held.release();
      await h.bureau.internals.whenTaskRecorded(h.runId);
      opening[1]!.resolve();
      await after.rest();
      const rows = after.received.flatMap(({ event }) =>
        event.type === EventType.MESSAGES_SNAPSHOT ? event.messages : [],
      );
      if (outcome === 'completed') {
        expect(rows.filter((row) => row.content === 'Hello world')).toHaveLength(1);
        expect(
          after.received.filter(({ event }) => event.type === EventType.TEXT_MESSAGE_CONTENT),
        ).toHaveLength(0);
      }
      if (outcome === 'aborted') {
        expect(
          after.received.flatMap(({ event }) =>
            event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
          ),
        ).toEqual(['Hello']);
      }
      expect(after.received.at(-1)?.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: outcome === 'completed' ? 'success' : 'cancelled' },
      });
    } finally {
      held.release();
      for (const gate of opening) gate.resolve();
      await h.dispose();
    }
  });
}

test('a failed terminal session save cannot discard recovery state or block the waiting reader', async () => {
  const diagnostics: string[] = [];
  const h = await setup(2, (diagnostic) => diagnostics.push(diagnostic.message));
  const failure = h.seam!.failWrites(savesSessionAs('aborted'), new Error('held storage failure'));
  const opening = Promise.withResolvers<void>();
  try {
    h.delta('Hello', 'Hello');
    await h.starter.until(EventType.TEXT_MESSAGE_CONTENT);
    await h.starter.cancel();
    const entered = Promise.withResolvers<void>();
    const events = h.bureau.tasks.events.bind(h.bureau.tasks);
    let first = true;
    h.bureau.tasks.events = async (...arguments_) => {
      if (first) {
        first = false;
        entered.resolve();
        await opening.promise;
      }
      return events(...arguments_);
    };
    const reader = new FrameReader(await h.handler(attach(h.runId, 'malformed')));
    await entered.promise;
    void h.bureau.tasks.cancel(h.runId);
    await h.bureau.internals.whenTaskRecorded(h.runId);
    expect(failure.attempts()).toBe(3);
    expect(
      diagnostics.some((message) => message.includes('Failed to persist aborted session state')),
    ).toBe(true);
    opening.resolve();
    await reader.rest();
    expect(
      reader.received.flatMap(({ event }) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
      ),
    ).toEqual(['Hello']);
    expect(reader.received.at(-1)?.event).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
    expect(h.listeners.size).toBe(1);
  } finally {
    failure.stop();
    opening.resolve();
    await h.dispose();
  }
});
