/**
 * The relay between the public listener and Weft's private server (`engine-proxy.ts`): what it
 * strips from a caller, what it preserves from the engine, and how it carries streams and
 * WebSockets. Each test stands a fake engine behind a minimal listener that uses the relay's own
 * exports exactly as `host.ts` does.
 */
import { afterEach, expect, test } from 'bun:test';

import {
  createLocalAuthentication,
  isEngineRequestPath,
  LOCAL_SUBJECT,
  relayRequest,
  upstreamHeaders,
  webSocketRelayData,
  webSocketRelayHandlers,
  type WebSocketRelayData,
} from './engine-proxy.ts';

const KEY = 'private-key-for-the-tests';
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Poll until `read` returns a value; the poll is a wait for an event, not a time bound. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
}

type UpstreamData = { headers: Headers };

function startUpstream(handlers: {
  fetch(
    request: Request,
    server: Bun.Server<UpstreamData>,
  ): Response | undefined | Promise<Response | undefined>;
  websocket?: Bun.WebSocketHandler<UpstreamData>;
}): string {
  const server = Bun.serve<UpstreamData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handlers.fetch,
    websocket: handlers.websocket ?? { message() {} },
  });
  cleanups.push(() => server.stop(true));
  return server.url.origin;
}

/** A listener wired to the relay the way `host.ts` wires it. */
function startRelay(upstream: string): URL {
  const server = Bun.serve<WebSocketRelayData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, instance) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const data = webSocketRelayData(request, upstream, KEY);
        if (data !== undefined && instance.upgrade(request, { data })) return undefined;
        return new Response('Not found', { status: 404 });
      }
      return relayRequest(request, upstream, KEY);
    },
    websocket: webSocketRelayHandlers,
  });
  cleanups.push(() => server.stop(true));
  return server.url;
}

function messageFrom(socket: WebSocket): Promise<string | ArrayBuffer | Blob> {
  return new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data), { once: true }),
  );
}

async function openSocket(url: URL): Promise<WebSocket> {
  const target = new URL(url);
  target.protocol = 'ws:';
  const socket = new WebSocket(target.toString());
  cleanups.push(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('The socket did not open.')), {
      once: true,
    });
  });
  return socket;
}

test('the relay owns exactly the paths Weft serves', () => {
  expect(isEngineRequestPath('/jsonrpc')).toBe(true);
  expect(isEngineRequestPath('/v1/workflows')).toBe(true);
  expect(isEngineRequestPath('/.well-known/openrpc.json')).toBe(true);
  expect(isEngineRequestPath('/apiary')).toBe(false);
  expect(isEngineRequestPath('/runs')).toBe(false);
});

test('the relay replaces every caller credential with its own key and drops hop headers', () => {
  const request = new Request('http://127.0.0.1/jsonrpc', {
    headers: {
      authorization: 'Bearer stolen',
      'x-api-key': 'caller-chosen',
      cookie: 'session=1',
      connection: 'keep-alive',
      host: 'attacker.example',
      'content-type': 'application/json',
    },
  });

  const headers = upstreamHeaders(request, KEY);

  expect(headers.get('x-api-key')).toBe(KEY);
  expect(headers.get('authorization')).toBeNull();
  expect(headers.get('cookie')).toBeNull();
  expect(headers.get('connection')).toBeNull();
  expect(headers.get('host')).toBeNull();
  expect(headers.get('content-type')).toBe('application/json');
});

test('the private listener admits only the relay key, as the local caller with every scope', async () => {
  const authentication = createLocalAuthentication(KEY);
  const resolve = authentication.resolveApiKeyPrincipal;
  if (resolve === undefined) throw new Error('Expected an API key resolver.');

  const admitted = await resolve(KEY);
  expect(admitted?.subject).toBe(LOCAL_SUBJECT);
  expect(await resolve(`${KEY}x`)).toBeNull();
  expect(await resolve('')).toBeNull();
  expect(await resolve(KEY.slice(0, -1))).toBeNull();
});

test('the relay sends its key upstream and never the caller-supplied credential', async () => {
  let seen: Headers | undefined;
  const upstream = startUpstream({
    fetch(request) {
      seen = request.headers;
      return new Response('ok');
    },
  });
  const relay = startRelay(upstream);

  const response = await fetch(new URL('/jsonrpc', relay), {
    headers: { authorization: 'Bearer stolen', 'x-api-key': 'caller-chosen' },
  });

  expect(response.status).toBe(200);
  expect(seen?.get('x-api-key')).toBe(KEY);
  expect(seen?.get('authorization')).toBeNull();
});

test('the relay preserves upstream redirects for the client instead of following them', async () => {
  const upstream = startUpstream({
    fetch: () => new Response(null, { headers: { location: '/v1/workflows/wf_1' }, status: 302 }),
  });
  const relay = startRelay(upstream);

  const response = await fetch(new URL('/v1/redirect', relay), { redirect: 'manual' });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/v1/workflows/wf_1');
});

test('the relay answers 502 when the engine cannot be reached', async () => {
  const released = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const gone = released.url.origin;
  await released.stop(true);
  const relay = startRelay(gone);

  const response = await fetch(new URL('/v1/anything', relay));

  expect(response.status).toBe(502);
});

test('the relay cancels a streaming upstream response when the downstream reader cancels', async () => {
  let bodyCancelled = false;
  let signalAborted = false;
  const upstream = startUpstream({
    fetch(request) {
      request.signal.addEventListener(
        'abort',
        () => {
          signalAborted = true;
        },
        { once: true },
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: connected\n\n'));
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const relay = startRelay(upstream);

  const response = await fetch(new URL('/v1/events', relay));
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Expected a streaming response body.');
  const chunk = await reader.read();
  if (chunk.done) throw new Error('Expected the first event.');
  await reader.cancel('test downstream cancellation');

  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(new TextDecoder().decode(chunk.value)).toBe('data: connected\n\n');
  await waitFor(() => (bodyCancelled && signalAborted ? true : undefined));
});

test('the relay strips encoded-body headers once the body has been decoded', async () => {
  const payload = 'relayed gzip payload';
  const compressed = Bun.gzipSync(new TextEncoder().encode(payload));
  const upstream = startUpstream({
    fetch: () =>
      new Response(compressed, {
        headers: {
          'content-encoding': 'gzip',
          'content-length': String(compressed.byteLength),
          'content-type': 'text/plain;charset=utf-8',
        },
      }),
  });
  const relay = startRelay(upstream);

  const response = await fetch(new URL('/v1/gzip', relay));

  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('content-length')).not.toBe(String(compressed.byteLength));
  expect(await response.text()).toBe(payload);
});

test('the relay carries WebSocket text and binary frames to the engine and back', async () => {
  const received: (string | number[])[] = [];
  let authorization: string | null | undefined;
  let apiKey: string | null | undefined;
  const upstream = startUpstream({
    fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        authorization = request.headers.get('authorization');
        apiKey = request.headers.get('x-api-key');
        if (server.upgrade(request, { data: { headers: request.headers } })) return undefined;
      }
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    },
    websocket: {
      message(socket, message) {
        received.push(
          typeof message === 'string' ? message : [...new Uint8Array(message as Uint8Array)],
        );
        socket.send(message);
      },
    },
  });
  const relay = startRelay(upstream);
  const client = await openSocket(new URL('/jsonrpc', relay));

  const textEcho = messageFrom(client);
  client.send('hello');
  expect(await textEcho).toBe('hello');
  const binaryEcho = messageFrom(client);
  client.send(new Uint8Array([4, 5, 6]));
  const echoed = await binaryEcho;
  const echoedBytes =
    echoed instanceof Blob
      ? [...new Uint8Array(await echoed.arrayBuffer())]
      : [...new Uint8Array(echoed as ArrayBuffer)];

  expect(received).toEqual(['hello', [4, 5, 6]]);
  expect(echoedBytes).toEqual([4, 5, 6]);
  expect(apiKey).toBe(KEY);
  expect(authorization).toBeNull();
});

test('the relay closes the client socket with 1011 when the engine connection fails', async () => {
  const released = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const gone = released.url.origin;
  await released.stop(true);
  const relay = startRelay(gone);
  const target = new URL('/jsonrpc', relay);
  target.protocol = 'ws:';
  const client = new WebSocket(target.toString());
  cleanups.push(() => client.close());

  const closed = await new Promise<CloseEvent>((resolve) =>
    client.addEventListener('close', resolve, { once: true }),
  );

  expect(closed.code).toBe(1011);
  expect(closed.reason).toBe('Upstream WebSocket error');
});

test('the relay refuses to upgrade a path the engine does not own', () => {
  const request = new Request('http://127.0.0.1/runs', { headers: { upgrade: 'websocket' } });

  expect(webSocketRelayData(request, 'http://127.0.0.1:1', KEY)).toBeUndefined();
});
