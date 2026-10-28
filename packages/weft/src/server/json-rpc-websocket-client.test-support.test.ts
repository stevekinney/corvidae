import { afterEach, describe, expect, it } from 'bun:test';

import type { WeftServer } from './index.ts';
import { collectWebSocketDeliveredEnvelopes } from './json-rpc-websocket-client.test-support.ts';

type FakeServer = ReturnType<typeof Bun.serve>;

const servers: FakeServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A fake `/jsonrpc` endpoint whose per-frame behaviour the test scripts. */
function startFakeEndpoint(
  onMessage: (socket: Bun.ServerWebSocket<unknown>, text: string) => void,
) {
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      return bunServer.upgrade(request)
        ? undefined
        : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, message) {
        onMessage(socket, String(message));
      },
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}` } as WeftServer;
}

describe('collectWebSocketDeliveredEnvelopes', () => {
  it('skips frames that are not JSON or not objects, then collects the delivered envelopes', async () => {
    const envelope = { kind: 'workflow:started', sequence: 0 };
    const server = startFakeEndpoint((socket, text) => {
      const request = JSON.parse(text) as { id: string };
      socket.send('this frame is not JSON');
      socket.send('"a bare string"');
      socket.send('null');
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'sub-1' } }),
      );
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.events.deliver',
          params: { subscriptionId: 'sub-1', envelope },
        }),
      );
    });

    const delivered = await collectWebSocketDeliveredEnvelopes(server, 'wf-1', 1, 'unused-key');

    expect(delivered).toEqual([envelope as never]);
  });

  it('rejects once the wait budget passes without enough envelopes', async () => {
    const server = startFakeEndpoint(() => {});

    await expect(
      collectWebSocketDeliveredEnvelopes(server, 'wf-1', 1, 'unused-key', 'timeout', 50),
    ).rejects.toThrow('collectWebSocketDeliveredEnvelopes timed out');
  });
});
