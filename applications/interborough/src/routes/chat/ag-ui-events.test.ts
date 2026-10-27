import { expect, test } from 'bun:test';

import { readEventFrames } from './ag-ui-events.ts';

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
      event: { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
    },
  ]);
});
