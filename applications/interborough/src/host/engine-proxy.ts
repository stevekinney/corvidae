/**
 * The relay between the host's public listener and Weft's own server.
 *
 * Weft's server answers `weft.system.principal` with the identity of whoever authenticated, and a
 * server with no authentication reports its own shared `unauthenticated-local` caller. The host
 * wants every request to act as `anonymous:local`, the owner Bureau gives an uncredentialed local
 * caller, so Weft's server runs on a private loopback port that answers only a per-process key,
 * and this relay is the only holder of that key. It attaches the key to every request it forwards
 * and removes any credential the caller sent, so no caller can choose another identity.
 *
 * The relay carries the whole transport matrix Weft serves: plain requests, streamed
 * Server-Sent Events, and WebSocket upgrades. Headers that describe one hop of a connection are
 * dropped rather than forwarded.
 *
 * @module engine-proxy
 */

import { timingSafeEqual } from 'node:crypto';

import {
  AUTHORIZATION_SCOPES,
  defaultAuthAuditSink,
  principalFromApiKey,
  type AuthConfig,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';

/** The caller every request acts as. Bureau owns what an uncredentialed local caller creates as this. */
export const LOCAL_SUBJECT = 'anonymous:local';

/** The path prefixes Weft's server owns; the relay forwards exactly these. */
const ENGINE_PATH_PREFIXES = [
  '/api',
  '/v1',
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
  '/.well-known',
  '/jsonrpc',
  '/mcp',
] as const;

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const;

const WEBSOCKET_HANDSHAKE_HEADERS = [
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
] as const;

/** The credentials a caller might send; none of them is honored. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'cookie'] as const;

/** Whether Weft's server owns `pathname`. */
export function isEngineRequestPath(pathname: string): boolean {
  return ENGINE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Weft's authentication for the private listener: one key, held by the relay, that stands for the
 * local caller with every Weft scope. Any other key, and no key, is refused.
 *
 * The audit trail keeps the refusals. Every request the relay forwards is admitted by
 * construction, so a line for each of them would only bury the one request that reached the
 * private port without the key.
 */
export function createLocalAuthentication(key: string): AuthConfig {
  const expected = Buffer.from(key);
  const principal = (): AuthenticatedPrincipal =>
    principalFromApiKey({ subject: LOCAL_SUBJECT, scopes: [...AUTHORIZATION_SCOPES] });
  return {
    auditSink: (event) => {
      if (event.outcome === 'failure') defaultAuthAuditSink(event);
    },
    resolveApiKeyPrincipal: async (presented) => {
      const candidate = Buffer.from(presented);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected)
        ? principal()
        : null;
    },
  };
}

/** The headers to send upstream: the caller's, without credentials or hop-specific ones, plus the key. */
export function upstreamHeaders(request: Request, key: string): Headers {
  const headers = new Headers(request.headers);
  for (const name of [
    ...CREDENTIAL_HEADERS,
    ...HOP_BY_HOP_HEADERS,
    ...WEBSOCKET_HANDSHAKE_HEADERS,
    'host',
  ]) {
    headers.delete(name);
  }
  headers.set('x-api-key', key);
  return headers;
}

function relayResponseBody(
  body: ReadableStream<Uint8Array> | null,
  cancelUpstream: () => void,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      cancelUpstream();
      await reader.cancel(reason);
    },
  });
}

/** Forward one request to `upstream` and stream the answer back. */
export async function relayRequest(
  request: Request,
  upstream: string,
  key: string,
): Promise<Response> {
  const source = new URL(request.url);
  const destination = new URL(`${source.pathname}${source.search}`, upstream);
  const upstreamAbort = new AbortController();
  request.signal.addEventListener('abort', () => upstreamAbort.abort(request.signal.reason), {
    once: true,
  });
  const init: RequestInit = {
    method: request.method,
    headers: upstreamHeaders(request, key),
    redirect: 'manual',
    signal: upstreamAbort.signal,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  let response: Response;
  try {
    response = await fetch(destination, init);
  } catch (error) {
    if (upstreamAbort.signal.aborted) throw error;
    return new Response('The engine did not answer.', { status: 502 });
  }
  const headers = new Headers(response.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  // `fetch` has already decoded the body, so the encoding and length no longer describe it.
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (headers.get('content-type')?.includes('text/event-stream')) {
    headers.set('cache-control', 'no-cache');
  }
  return new Response(
    relayResponseBody(response.body, () =>
      upstreamAbort.abort('downstream response body cancelled'),
    ),
    { status: response.status, statusText: response.statusText, headers },
  );
}

type RelayedMessage = string | ArrayBuffer | Blob;

/** What the host keeps for each WebSocket it relays. */
export type WebSocketRelayData = {
  /** Which plane owns the socket; the host's one WebSocket handler dispatches on it (`host-websocket.ts`). */
  readonly plane: 'engine';
  readonly upstream: string;
  readonly headers: Headers;
  pending: RelayedMessage[];
  socket?: WebSocket;
  upstreamOpen: boolean;
};

/** The data for relaying `request`'s upgrade to `upstream`, or `undefined` for a path the relay does not own. */
export function webSocketRelayData(
  request: Request,
  upstream: string,
  key: string,
): WebSocketRelayData | undefined {
  const url = new URL(request.url);
  if (!isEngineRequestPath(url.pathname)) return undefined;
  const target = new URL(`${url.pathname}${url.search}`, upstream);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    plane: 'engine',
    upstream: target.toString(),
    headers: upstreamHeaders(request, key),
    pending: [],
    upstreamOpen: false,
  };
}

function normalizeMessage(message: unknown): RelayedMessage {
  if (typeof message === 'string' || message instanceof Blob || message instanceof ArrayBuffer) {
    return message;
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice().buffer;
  }
  throw new TypeError('Unsupported WebSocket message type');
}

/**
 * Open the socket to Weft's server with the relay's headers. Bun's `WebSocket` takes request
 * headers as a constructor option, which the DOM typings the rest of this workspace compiles
 * against do not declare, so it is constructed reflectively and checked rather than asserted.
 */
function openUpstreamSocket(data: WebSocketRelayData): WebSocket {
  const options = { headers: Object.fromEntries(data.headers.entries()) };
  const socket: unknown = Reflect.construct(WebSocket, [data.upstream, options]);
  if (!(socket instanceof WebSocket)) throw new TypeError('The upstream WebSocket was not opened.');
  return socket;
}

/** The handlers `Bun.serve` needs to relay each upgraded socket to Weft's server. */
export const webSocketRelayHandlers: Bun.WebSocketHandler<WebSocketRelayData> = {
  open(client) {
    const upstreamSocket = openUpstreamSocket(client.data);
    client.data.socket = upstreamSocket;
    upstreamSocket.addEventListener('open', () => {
      client.data.upstreamOpen = true;
      for (const message of client.data.pending) upstreamSocket.send(message);
      client.data.pending = [];
    });
    upstreamSocket.addEventListener('message', (event) => client.send(event.data));
    upstreamSocket.addEventListener('close', (event) => client.close(event.code, event.reason));
    upstreamSocket.addEventListener('error', () => client.close(1011, 'Upstream WebSocket error'));
  },
  message(client, message) {
    const relayed = normalizeMessage(message);
    if (client.data.upstreamOpen) client.data.socket?.send(relayed);
    else client.data.pending.push(relayed);
  },
  close(client) {
    client.data.socket?.close();
  },
};
