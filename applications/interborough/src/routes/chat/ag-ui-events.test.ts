import { EventType } from '@ag-ui/core';
import { expect, test } from 'bun:test';

import { readEventFrames, readEvents } from './ag-ui-events.ts';

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
  await Array.fromAsync(
    readEvents(async () => response, { onCursor: (cursor) => cursors.push(cursor) }),
  );
  expect(cursors).toEqual(['old', undefined, 'new']);
});
