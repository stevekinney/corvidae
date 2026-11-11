import { EventType } from '@ag-ui/core';
import { expect, test } from 'bun:test';

import { acknowledgeEvent, readEventFrames, readEvents } from './ag-ui-events.ts';

test('preserves SSE cursors while validating AG-UI events', async () => {
  const frames = await Array.fromAsync(
    readEventFrames(
      async () =>
        new Response(
          'id: agui-live-v1.run.epoch.1\ndata: {"type":"RUN_STARTED","threadId":"thread","runId":"run"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  expect(frames).toEqual([
    {
      id: 'agui-live-v1.run.epoch.1',
      event: { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    },
  ]);
});

test('parses CRLF frame boundaries split between response chunks', async () => {
  const bytes = ['id: live-1\r', '\ndata: {"type":"STATE_SNAPSHOT","snapshot":{}}\r\n\r', '\n'];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of bytes) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
  const frames = await Array.fromAsync(readEventFrames(async () => new Response(stream)));
  expect(frames).toEqual([
    { id: 'live-1', event: { type: EventType.STATE_SNAPSHOT, snapshot: {} } },
  ]);
});

test('snapshot replacement clears the old cursor until reconstruction supplies the new cut', async () => {
  const cursors: Array<string | undefined> = [];
  const response = new Response(
    'id: old\ndata: {"type":"STATE_SNAPSHOT","snapshot":{}}\n\ndata: {"type":"MESSAGES_SNAPSHOT","messages":[]}\n\nid: new\ndata: {"type":"STEP_STARTED","stepName":"step-0"}\n\n',
  );
  for await (const event of readEvents(async () => response, {
    onCursor: (cursor) => cursors.push(cursor),
  }))
    acknowledgeEvent(event);
  expect(cursors).toEqual(['old', undefined, 'new']);
});

test('a cursor is committed when its event is acknowledged, not when it is read, and only once', async () => {
  const cursors: Array<string | undefined> = [];
  const response = new Response(
    'id: first\ndata: {"type":"STEP_STARTED","stepName":"step-0"}\n\nid: second\ndata: {"type":"STEP_FINISHED","stepName":"step-0"}\n\n',
  );
  const read: unknown[] = [];
  for await (const event of readEvents(async () => response, {
    onCursor: (cursor) => cursors.push(cursor),
  }))
    read.push(event);

  // Both events were read, and neither was accepted yet.
  expect(read).toHaveLength(2);
  expect(cursors).toEqual([]);

  acknowledgeEvent(read[0]);
  acknowledgeEvent(read[0]);
  expect(cursors).toEqual(['first']);

  acknowledgeEvent(read[1]);
  expect(cursors).toEqual(['first', 'second']);
});

test('acknowledging an event that carried no cursor, or was never read, commits nothing', async () => {
  const cursors: Array<string | undefined> = [];
  const response = new Response('data: {"type":"STEP_STARTED","stepName":"step-0"}\n\n');
  for await (const event of readEvents(async () => response, {
    onCursor: (cursor) => cursors.push(cursor),
  }))
    acknowledgeEvent(event);
  acknowledgeEvent({ type: EventType.STEP_STARTED, stepName: 'step-0' });
  acknowledgeEvent(undefined);
  expect(cursors).toEqual([]);
});
