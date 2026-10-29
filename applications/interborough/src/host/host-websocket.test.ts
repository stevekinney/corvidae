/**
 * The one WebSocket handler the public listener registers (`host-websocket.ts`): each event goes to
 * the plane that owns the socket. A listener here upgrades by path, tagging the data the way the
 * host does, and each plane's handlers record what reached them.
 */
import { afterEach, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import {
  bureauUpgradeServer,
  hostWebSocketHandlers,
  type BureauHandler,
  type HostSocketData,
} from './host-websocket.ts';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Each event a plane's handlers received, as `<event>:<plane>`. */
function startListener(): { readonly url: URL; readonly events: string[] } {
  const events: string[] = [];
  const bureau: BureauHandler['websocket'] = {
    open: () => void events.push('open:bureau'),
    message: (_socket, message) => void events.push(`message:bureau:${String(message)}`),
    close: () => void events.push('close:bureau'),
  };
  const engine: Bun.WebSocketHandler<Extract<HostSocketData, { plane: 'engine' }>> = {
    open: () => void events.push('open:engine'),
    message: (_socket, message) => void events.push(`message:engine:${String(message)}`),
    close: () => void events.push('close:engine'),
  };
  const server = Bun.serve<HostSocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, listener) {
      const { pathname } = new URL(request.url);
      if (pathname === '/bureau') {
        const accepted = new Request(new URL('/jsonrpc', request.url), request);
        const adapter = bureauUpgradeServer(listener, request);
        // Bureau's upgrade hands over its own data without the tag.
        if (
          adapter.upgrade(accepted, { data: { pathname: '/jsonrpc', connectionType: 'jsonrpc' } })
        ) {
          return undefined;
        }
      } else if (
        listener.upgrade(request, {
          data: {
            plane: 'engine',
            upstream: 'ws://127.0.0.1:1/',
            headers: new Headers(),
            pending: [],
            upstreamOpen: false,
          },
        })
      ) {
        return undefined;
      }
      return new Response('Upgrade failed', { status: 500 });
    },
    websocket: hostWebSocketHandlers(bureau, engine),
  });
  cleanups.push(() => server.stop(true));
  return { url: new URL(`ws://127.0.0.1:${server.port}/`), events };
}

async function openSocket(url: URL): Promise<WebSocket> {
  const socket = new WebSocket(url);
  cleanups.push(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('The socket did not open.')), {
      once: true,
    });
  });
  return socket;
}

test('a Bureau socket reaches only Bureau’s handlers, and closing it calls only Bureau’s close', async () => {
  const { url, events } = startListener();
  const socket = await openSocket(new URL('/bureau', url));
  socket.send('hello');
  await waitUntil(() => events.includes('message:bureau:hello'), { message: 'the message' });
  socket.close();
  await waitUntil(() => events.includes('close:bureau'), { message: 'the close' });

  expect(events).toEqual(['open:bureau', 'message:bureau:hello', 'close:bureau']);
});

test('an engine socket reaches only the relay’s handlers, and closing it calls only the relay’s close', async () => {
  const { url, events } = startListener();
  const socket = await openSocket(new URL('/jsonrpc', url));
  socket.send('hello');
  await waitUntil(() => events.includes('message:engine:hello'), { message: 'the message' });
  socket.close();
  await waitUntil(() => events.includes('close:engine'), { message: 'the close' });

  expect(events).toEqual(['open:engine', 'message:engine:hello', 'close:engine']);
});

test('sockets of both planes open at once keep to their own handlers', async () => {
  const { url, events } = startListener();
  const bureau = await openSocket(new URL('/bureau', url));
  const engine = await openSocket(new URL('/jsonrpc', url));
  bureau.send('one');
  engine.send('two');
  await waitUntil(
    () => events.includes('message:bureau:one') && events.includes('message:engine:two'),
    { message: 'both messages' },
  );
  bureau.close();
  await waitUntil(() => events.includes('close:bureau'), { message: 'the Bureau close' });

  expect(events).not.toContain('close:engine');
  engine.close();
  await waitUntil(() => events.includes('close:engine'), { message: 'the engine close' });
});
