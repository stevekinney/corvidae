import { serve } from '@lostgradient/node-host';
import { test } from 'node:test';

import { createRuntimeSmokeHandler, runRuntimeSmoke } from './runtime-smoke.ts';

test('Backchannel REST and WebSocket smoke', async () => {
  const handler = createRuntimeSmokeHandler();
  let host: ReturnType<typeof serve> | undefined;
  host = serve({
    port: 0,
    async fetch(request) {
      if (await handler.upgrade(request, host!)) return undefined;
      return handler(request);
    },
    websocket: handler.websocket,
  });
  try {
    await host.ready;
    await runRuntimeSmoke(
      host.url,
      (url, request) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(url.toString().replace(/^http/u, 'ws'));
          socket.addEventListener(
            'error',
            () => reject(new Error('WebSocket connection failed.')),
            { once: true },
          );
          socket.addEventListener('open', () => socket.send(request), { once: true });
          socket.addEventListener(
            'message',
            (event) => {
              socket.close();
              resolve(String(event.data));
            },
            { once: true },
          );
        }),
    );
  } finally {
    host.stop(true);
  }
});
