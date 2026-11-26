import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket as NodeSocket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TlsOptions } from 'node:tls';

import { WebSocketServer, WebSocket as WebSocketSocket } from 'ws';

const requestAbortControllers = new WeakMap<
  Request,
  { controller: AbortController; socket: NodeSocket }
>();
const socketAbortControllers = new WeakMap<NodeSocket, Set<AbortController>>();

type HostRouteHandler = (
  request: Request & { readonly params: Readonly<Record<string, string>> },
  server: NodeHost<unknown>,
) => Response | Promise<Response>;

/** A response, handler, or method map registered in {@link ServeOptions.routes}. */
export type HostRoute =
  Response | HostRouteHandler | Partial<Record<string, Response | HostRouteHandler>>;

/** The Bun-compatible operations available to a server-side WebSocket. */
export type Socket<Data> = {
  /** Data supplied to {@link NodeHost.upgrade}. */
  readonly data: Data;
  /** The `ws` ready-state number. */
  readonly readyState: number;
  /** Begins a normal WebSocket close handshake. */
  close(code?: number, reason?: string): void;
  /** Reports whether the socket belongs to a published topic. */
  isSubscribed(topic: string): boolean;
  /** Sends one text or binary message and reports whether it was admitted. */
  send(message: string): number;
  /** Adds the socket to a publication topic. */
  subscribe(topic: string): void;
  /** Immediately closes the underlying transport. */
  terminate(): void;
  /** Removes the socket from a publication topic. */
  unsubscribe(topic: string): void;
};

/** Callback and transport limits for WebSocket connections. */
export type WebSocketHandlers<Data> = {
  /** Observes a completed socket close. */
  readonly close?: (socket: Socket<Data>, code: number, reason: string) => void;
  /** Observes that the underlying socket drained buffered output. */
  readonly drain?: (socket: Socket<Data>) => void;
  /** Socket inactivity timeout in seconds. */
  readonly idleTimeout?: number;
  /** Largest accepted WebSocket frame in bytes. */
  readonly maxPayloadLength?: number;
  /** Receives one text or binary message. */
  readonly message?: (socket: Socket<Data>, message: string | Uint8Array) => void;
  /** Receives a socket after its upgrade completes. */
  readonly open?: (socket: Socket<Data>) => void;
};

/** Inputs accepted by the explicit Node host. */
export type ServeOptions<Data> = {
  /** Handles requests that no exact route claims, including upgrade requests. */
  readonly fetch: (request: Request) => Response | Promise<Response | undefined> | undefined;
  /** Preserved for Bun host parity; Node does not implement Bun development mode. */
  readonly development?: boolean;
  /** Seconds an idle HTTP connection may remain open. */
  readonly idleTimeout?: number;
  /** Interface on which Node listens. */
  readonly hostname?: string;
  /** TCP port on which Node listens. */
  readonly port?: number;
  /** Exact path handlers evaluated before {@link fetch}. */
  readonly routes?: Readonly<Record<string, HostRoute>>;
  /** TLS options passed intact to Node's HTTPS server, including mTLS enforcement. */
  readonly tls?: Pick<TlsOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized' | 'requestCert'>;
  /** WebSocket lifecycle callbacks and transport limits. */
  readonly websocket?: WebSocketHandlers<Data>;
};

/** The running Node server and its Bun-compatible host operations. */
export type NodeHost<Data> = {
  /** Interface selected when the server was created. */
  readonly hostname: string;
  /** Bound TCP port, including the ephemeral port selected for `0`. */
  readonly port: number;
  /** Resolves once Node has bound the configured port. */
  readonly ready: Promise<void>;
  /** Base URL constructed from the bound address. */
  readonly url: URL;
  /** Sends a message to every socket subscribed to one topic. */
  publish(topic: string, message: string): number;
  /** Returns the remote peer information for a pending request. */
  requestIP(
    request: Request,
  ): { address: string; family: 'IPv4' | 'IPv6'; port: number } | undefined;
  /** Stops accepting requests and optionally terminates active sockets. */
  stop(closeActiveConnections?: boolean): void;
  /** Sets the underlying request socket timeout in seconds. */
  timeout(request: Request, seconds: number): void;
  /** Completes a pending HTTP upgrade and associates caller data with its socket. */
  upgrade(request: Request, options: { data: Data }): boolean;
};

type PendingUpgrade = {
  request: IncomingMessage;
  socket: import('node:stream').Duplex;
  head: Buffer;
};

function requestUrl(
  request: IncomingMessage,
  hostname: string,
  port: number,
  secure: boolean,
): URL {
  const host = request.headers.host ?? `${hostname}:${port}`;
  return new URL(request.url ?? '/', `${secure ? 'https' : 'http'}://${host}`);
}

function requestFromIncoming(
  request: IncomingMessage,
  hostname: string,
  port: number,
  secure: boolean,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const controller = new AbortController();
  let controllers = socketAbortControllers.get(request.socket);
  if (controllers === undefined) {
    controllers = new Set();
    socketAbortControllers.set(request.socket, controllers);
    request.socket.once('close', () => {
      for (const active of controllers ?? []) active.abort();
      socketAbortControllers.delete(request.socket);
    });
  }
  controllers.add(controller);
  request.once('aborted', () => controller.abort());
  const init: RequestInit & { duplex?: 'half' } = {
    headers,
    method: request.method ?? 'GET',
    signal: controller.signal,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Readable.toWeb(request) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  const fetchRequest = new Request(requestUrl(request, hostname, port, secure), init);
  requestAbortControllers.set(fetchRequest, { controller, socket: request.socket });
  return fetchRequest;
}

function releaseRequestAbort(request: Request): void {
  const entry = requestAbortControllers.get(request);
  if (entry === undefined) return;
  socketAbortControllers.get(entry.socket)?.delete(entry.controller);
  requestAbortControllers.delete(request);
}

async function sendResponse(response: ServerResponse, source: Response): Promise<void> {
  response.statusCode = source.status;
  source.headers.forEach((value, name) => response.setHeader(name, value));
  // An SSE response may wait indefinitely for its first event. Flush its
  // headers before reading the stream so the client can establish and later
  // cancel the subscription without waiting for a payload.
  response.flushHeaders();
  if (source.body === null) {
    response.end();
    return;
  }
  // `pipeline` propagates a client disconnect through `Readable.fromWeb`,
  // cancelling the Web stream. A hand-rolled read/write loop leaves an SSE
  // subscription awaiting its next event after the HTTP response closes.
  await pipeline(
    Readable.fromWeb(source.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    response,
  );
}

function routeResponse(
  route: HostRoute | undefined,
  request: Request & { readonly params: Readonly<Record<string, string>> },
  server: NodeHost<unknown>,
): Response | Promise<Response> | undefined {
  if (route === undefined) return undefined;
  if (typeof route === 'object' && !(route instanceof Response)) {
    return Object.hasOwn(route, request.method)
      ? routeResponse(route[request.method], request, server)
      : undefined;
  }
  return typeof route === 'function' ? route(request, server) : route.clone();
}

async function rejectUpgrade(
  socket: import('node:stream').Duplex,
  response: Response,
): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.set('Connection', 'close');
  headers.set('Content-Length', String(body.byteLength));
  const lines = [...headers].map(([name, value]) => `${name}: ${value}`);
  socket.write(
    `HTTP/1.1 ${response.status} ${response.statusText || 'Response'}\r\n${lines.join('\r\n')}\r\n\r\n`,
  );
  socket.end(body);
}

function routeFor(
  routes: ServeOptions<unknown>['routes'],
  pathname: string,
  method: string,
): { route: HostRoute; params: Readonly<Record<string, string>> } | undefined {
  if (routes === undefined) return undefined;
  const candidates = Object.entries(routes)
    .map(([pattern, route]) => ({
      pattern,
      route,
      rank: pattern.includes('*') ? 2 : pattern.includes(':') ? 1 : 0,
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank || compareRouteSpecificity(left.pattern, right.pattern),
    );
  for (const { pattern, route } of candidates) {
    if (!routeHandlesMethod(route, method)) continue;
    const names: string[] = [];
    const expression = pattern
      .split('/')
      .map((segment) => {
        if (segment === '*') return '(.*)';
        if (segment.startsWith(':')) {
          names.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const match = new RegExp(`^${expression}$`).exec(pathname);
    if (match === null) continue;
    return {
      route,
      params: Object.fromEntries(
        names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
      ),
    };
  }
  return undefined;
}

function compareRouteSpecificity(left: string, right: string): number {
  const leftSegments = left.split('/').filter(Boolean);
  const rightSegments = right.split('/').filter(Boolean);
  const rank = (segment: string): number => (segment === '*' ? 0 : segment.startsWith(':') ? 1 : 2);
  for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index++) {
    const difference = rank(rightSegments[index]!) - rank(leftSegments[index]!);
    if (difference !== 0) return difference;
  }
  return rightSegments.length - leftSegments.length;
}

function routeHandlesMethod(route: HostRoute, method: string): boolean {
  return typeof route !== 'object' || route instanceof Response || Object.hasOwn(route, method);
}

/**
 * Starts an explicit Node host. Callers choose this host instead of Bun.serve, so this module
 * never detects or switches runtimes at run time.
 */
export function serve<Data>(options: ServeOptions<Data>): NodeHost<Data> {
  const hostname = options.hostname ?? '127.0.0.1';
  const requestedPort = options.port ?? 3000;
  const secure = options.tls !== undefined;
  const requests = new WeakMap<Request, IncomingMessage>();
  const pending = new WeakMap<Request, PendingUpgrade>();
  const subscriptions = new Map<string, Set<Socket<Data>>>();
  const sockets = new Set<WebSocketSocket>();
  let nodeHost!: NodeHost<Data>;
  const wrappers = new WeakMap<WebSocketSocket, Socket<Data>>();
  const webSocket = options.websocket;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: webSocket?.maxPayloadLength,
  });

  const wrapperFor = (raw: WebSocketSocket, data: Data): Socket<Data> => {
    const existing = wrappers.get(raw);
    if (existing !== undefined) return existing;
    const topics = new Set<string>();
    const wrapper: Socket<Data> = {
      data,
      get readyState() {
        return raw.readyState;
      },
      close(code, reason) {
        raw.close(code, reason);
      },
      isSubscribed(topic) {
        return topics.has(topic);
      },
      send(message) {
        if (raw.readyState !== WebSocketSocket.OPEN) return 0;
        raw.send(message);
        return 1;
      },
      subscribe(topic) {
        topics.add(topic);
        let members = subscriptions.get(topic);
        if (members === undefined) {
          members = new Set();
          subscriptions.set(topic, members);
        }
        members.add(wrapper);
      },
      terminate() {
        raw.terminate();
      },
      unsubscribe(topic) {
        topics.delete(topic);
        const members = subscriptions.get(topic);
        members?.delete(wrapper);
        if (members?.size === 0) subscriptions.delete(topic);
      },
    };
    wrappers.set(raw, wrapper);
    return wrapper;
  };

  const server = options.tls === undefined ? createHttpServer() : createHttpsServer(options.tls);

  server.on('request', async (incoming, outgoing) => {
    const request = requestFromIncoming(incoming, hostname, requestedPort, secure);
    requests.set(request, incoming);
    try {
      const matched = routeFor(options.routes, new URL(request.url).pathname, request.method);
      const routedRequest = Object.assign(request, { params: matched?.params ?? {} });
      const response = await (routeResponse(
        matched?.route,
        routedRequest,
        nodeHost as NodeHost<unknown>,
      ) ?? options.fetch(request));
      await sendResponse(outgoing, response ?? new Response('Not found', { status: 404 }));
    } catch {
      if (!outgoing.headersSent)
        await sendResponse(outgoing, new Response('Internal server error', { status: 500 }));
      else outgoing.destroy();
    } finally {
      releaseRequestAbort(request);
    }
  });

  server.on('upgrade', (incoming, socket, head) => {
    const request = requestFromIncoming(incoming, hostname, requestedPort, secure);
    requests.set(request, incoming);
    pending.set(request, { request: incoming, socket, head });
    void Promise.resolve(options.fetch(request)).then((response) => {
      if (pending.has(request)) {
        pending.delete(request);
        const fallback = response ?? new Response('Not found', { status: 404 });
        void rejectUpgrade(socket, fallback);
      }
      releaseRequestAbort(request);
      return undefined;
    });
  });

  webSocketServer.on(
    'connection',
    (raw: WebSocketSocket, _request: IncomingMessage, data: Data) => {
      sockets.add(raw);
      const socket = wrapperFor(raw, data);
      raw.on('message', (message, binary) => {
        const bytes = Array.isArray(message)
          ? Buffer.concat(message)
          : Buffer.isBuffer(message)
            ? message
            : Buffer.from(message);
        webSocket?.message?.(socket, binary ? new Uint8Array(bytes) : bytes.toString());
      });
      // `ws` emits an Error before it closes a peer that exceeds maxPayload. The close code is the
      // contract surface callers observe, so keep the transport error from becoming an uncaught
      // EventEmitter exception.
      raw.on('error', () => undefined);
      raw.on('close', (code, reason) => {
        sockets.delete(raw);
        for (const topic of Array.from(subscriptions.keys())) socket.unsubscribe(topic);
        webSocket?.close?.(socket, code, reason.toString());
      });
      raw.on('drain', () => webSocket?.drain?.(socket));
      webSocket?.open?.(socket);
    },
  );

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const idleTimeout = options.idleTimeout ?? webSocket?.idleTimeout;
  if (idleTimeout !== undefined) server.setTimeout(idleTimeout * 1_000);

  nodeHost = {
    hostname,
    ready,
    get port() {
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : requestedPort;
    },
    get url() {
      return new URL(`${options.tls === undefined ? 'http' : 'https'}://${hostname}:${this.port}`);
    },
    publish(topic, message) {
      let count = 0;
      for (const socket of subscriptions.get(topic) ?? []) count += socket.send(message);
      return count;
    },
    requestIP(request) {
      const raw = requests.get(request);
      if (raw?.socket.remoteAddress === undefined || raw.socket.remotePort === undefined)
        return undefined;
      return {
        address: raw.socket.remoteAddress,
        family: raw.socket.remoteFamily === 'IPv6' ? 'IPv6' : 'IPv4',
        port: raw.socket.remotePort,
      };
    },
    stop(closeActiveConnections = false) {
      webSocketServer.close();
      server.close();
      if (!closeActiveConnections) return;
      // `server.close()` stops accepting connections but lets current HTTP
      // responses drain. For a forced stop, close them after admission has
      // stopped; upgraded sockets are not included, so terminate those too.
      server.closeAllConnections();
      for (const socket of sockets) socket.terminate();
    },
    timeout(request, seconds) {
      requests.get(request)?.socket.setTimeout(seconds * 1_000);
    },
    upgrade(request, { data }) {
      const upgrade = pending.get(request);
      if (upgrade === undefined) return false;
      pending.delete(request);
      releaseRequestAbort(request);
      webSocketServer.handleUpgrade(upgrade.request, upgrade.socket, upgrade.head, (raw) => {
        webSocketServer.emit('connection', raw, upgrade.request, data);
      });
      return true;
    },
  };
  return nodeHost;
}
