import { buildBrowser } from '@lostgradient/testing';
import { existsSync, unwatchFile, watch, watchFile, type Stats } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentConfiguration } from './environment-configuration.ts';

import { DEV_API_KEY } from './dev-credentials.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const defaultOutputDirectory = join(directory, 'build');
const configuration = environmentConfiguration();
const defaultPort = configuration.browserHostPort ?? 5173;
const defaultUpstream = configuration.weftApiBaseUrl ?? 'http://localhost:7233';
const proxyPathPrefixes = [
  '/api',
  '/v1',
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
  '/.well-known',
  '/jsonrpc',
  '/mcp',
];
const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const websocketHandshakeHeaders = [
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
];

type BrowserBuildState =
  | { readonly status: 'idle' }
  | { readonly status: 'building'; readonly promise: Promise<void> }
  | { readonly status: 'failed'; readonly error: unknown };

type BrowserHostOptions = {
  readonly buildOnStart?: boolean;
  readonly development?: boolean;
  readonly directory?: string;
  readonly outputDirectory?: string;
  readonly port?: number;
  readonly upstream?: string;
  readonly watch?: boolean;
};

type ProxyMessage = string | ArrayBuffer | Blob;

type ProxyData = {
  pending: ProxyMessage[];
  socket?: WebSocket;
  upstream: string;
  upstreamOpen: boolean;
  headers: Headers;
};

type BuildAssets = (state: BrowserHostState, development: boolean) => Promise<void>;

export type BrowserHost = {
  readonly server: Bun.Server<ProxyData>;
  readonly url: URL;
  close(): void;
};

export type BrowserHostState = {
  build: BrowserBuildState;
  buildAgain: boolean;
  buildAssets: BuildAssets;
  closed: boolean;
  readonly directory: string;
  readonly outputDirectory: string;
  pendingBuildTimer: ReturnType<typeof setTimeout> | undefined;
  readonly upstream: string;
};

type WebSocketWithHeadersConstructor = new (
  url: string | URL,
  options?: { readonly headers?: HeadersInit },
) => WebSocket;

export function buildWatchRoots(browserDirectory: string): string[] {
  return [
    join(browserDirectory, '../../src'),
    join(browserDirectory, '../../fixtures'),
    join(browserDirectory, '../../../cinder/src'),
    join(browserDirectory, '../../../../packages/markdown/src'),
    join(browserDirectory, '../../../../packages/weft/src'),
  ]
    .map((path) => resolve(path))
    .filter((path) => existsSync(path));
}

export function isProxyPath(pathname: string): boolean {
  return proxyPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function authorizedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${DEV_API_KEY}`);
  for (const header of [...hopByHopHeaders, ...websocketHandshakeHeaders]) {
    headers.delete(header);
  }
  return headers;
}

export function normalizeMessage(message: unknown): ProxyMessage {
  if (typeof message === 'string' || message instanceof Blob || message instanceof ArrayBuffer) {
    return message;
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice().buffer;
  }
  throw new TypeError('Unsupported WebSocket message type');
}

export function flushPendingMessagesToUpstream(data: Pick<ProxyData, 'pending' | 'socket'>): void {
  if (data.socket === undefined) return;
  for (const message of data.pending) data.socket.send(message);
  data.pending = [];
}

function connectWebSocket(upstream: string, headers: Headers): WebSocket {
  const WebSocketConstructor = WebSocket as WebSocketWithHeadersConstructor;
  return new WebSocketConstructor(upstream, { headers: Object.fromEntries(headers.entries()) });
}

async function buildAssets(state: BrowserHostState, development: boolean): Promise<void> {
  await buildBrowser({
    entrypoints: [join(state.directory, 'index.html')],
    outdir: state.outputDirectory,
    development,
  });
}

export function createBrowserHostState(options: {
  buildAssets?: BuildAssets;
  directory?: string;
  outputDirectory?: string;
  upstream?: string;
}): BrowserHostState {
  return {
    build: { status: 'idle' },
    buildAgain: false,
    buildAssets: options.buildAssets ?? buildAssets,
    closed: false,
    directory: options.directory ?? directory,
    outputDirectory: options.outputDirectory ?? defaultOutputDirectory,
    pendingBuildTimer: undefined,
    upstream: options.upstream ?? defaultUpstream,
  };
}

export function serializeBuild(state: BrowserHostState, development: boolean): Promise<void> {
  if (state.closed) return Promise.resolve();
  if (state.build.status === 'building') {
    state.buildAgain = true;
    return state.build.promise;
  }

  const promise = (async () => {
    do {
      state.buildAgain = false;
      try {
        await state.buildAssets(state, development);
      } catch (error) {
        if (!state.buildAgain || state.closed) throw error;
      }
    } while (state.buildAgain && !state.closed);
  })().then(
    () => {
      if (state.closed) return undefined;
      state.build = { status: 'idle' };
      return undefined;
    },
    (error: unknown) => {
      state.build = { status: 'failed', error };
      throw error;
    },
  );
  state.build = { status: 'building', promise };
  return promise;
}

export function scheduleBuild(state: BrowserHostState, development: boolean): void {
  if (state.closed) return;
  if (state.pendingBuildTimer !== undefined) clearTimeout(state.pendingBuildTimer);
  state.pendingBuildTimer = setTimeout(() => {
    state.pendingBuildTimer = undefined;
    if (state.closed) return;
    void serializeBuild(state, development).catch((error: unknown) => {
      if (!state.closed) console.error('Browser rebuild failed', error);
    });
  }, 100);
}

export function closeBrowserHostState(state: BrowserHostState): void {
  state.closed = true;
  if (state.pendingBuildTimer !== undefined) {
    clearTimeout(state.pendingBuildTimer);
    state.pendingBuildTimer = undefined;
  }
}

function watchSources(
  state: BrowserHostState,
  development: boolean,
  stopWatching: (() => void)[],
): void {
  for (const root of buildWatchRoots(state.directory)) {
    const watcher = watch(root, { recursive: true }, () => scheduleBuild(state, development));
    stopWatching.push(() => watcher.close());
  }
  // Stat watches preserve atomic saves of these two build-only entrypoints.
  // Native directory events can miss their first save on macOS.
  for (const filename of ['index.html', 'main.ts']) {
    const path = join(state.directory, filename);
    const changed = (current: Stats, previous: Stats) => {
      if (current.mtimeMs !== previous.mtimeMs || current.ino !== previous.ino) {
        scheduleBuild(state, development);
      }
    };
    watchFile(path, { interval: 100 }, changed);
    stopWatching.push(() => unwatchFile(path, changed));
  }
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

async function proxy(request: Request, upstream: string): Promise<Response> {
  const target = new URL(request.url);
  const destination = new URL(`${target.pathname}${target.search}`, upstream);
  const upstreamAbort = new AbortController();
  request.signal.addEventListener('abort', () => upstreamAbort.abort(request.signal.reason), {
    once: true,
  });
  const init: RequestInit = {
    method: request.method,
    headers: authorizedHeaders(request),
    redirect: 'manual',
    signal: upstreamAbort.signal,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  const response = await fetch(destination, init);
  const headers = new Headers(response.headers);
  for (const header of hopByHopHeaders) {
    headers.delete(header);
  }
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (headers.get('content-type')?.includes('text/event-stream'))
    headers.set('cache-control', 'no-cache');
  return new Response(
    relayResponseBody(response.body, () =>
      upstreamAbort.abort('downstream response body cancelled'),
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

function resolveAssetPath(outputDirectory: string, pathname: string): string | undefined {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(relativePath);
  const root = resolve(outputDirectory);
  const filePath = resolve(root, `.${decodedPath}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return undefined;
  return filePath;
}

function shouldFallbackToIndex(pathname: string): boolean {
  const segment = pathname.split('/').at(-1) ?? '';
  return !segment.includes('.');
}

async function serveAsset(request: Request, state: BrowserHostState): Promise<Response> {
  if (state.build.status === 'building') {
    return new Response('Browser assets are rebuilding.', { status: 503 });
  }
  if (state.build.status === 'failed') {
    return new Response('Browser asset build failed.', { status: 503 });
  }

  const url = new URL(request.url);
  let filePath: string | undefined;
  try {
    filePath = resolveAssetPath(state.outputDirectory, url.pathname);
  } catch (error) {
    if (error instanceof URIError) return new Response('Malformed asset path.', { status: 400 });
    throw error;
  }
  if (filePath === undefined) return new Response('Not found', { status: 404 });

  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file);
  if (!shouldFallbackToIndex(url.pathname)) return new Response('Not found', { status: 404 });

  const fallback = Bun.file(join(state.outputDirectory, 'index.html'));
  if (await fallback.exists()) return new Response(fallback);
  return new Response('Browser assets are not built.', { status: 503 });
}

function createFetchHandler(state: BrowserHostState) {
  return async (request: Request, server: Bun.Server<ProxyData>): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
      isProxyPath(url.pathname)
    ) {
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, state.upstream);
      if (upstreamUrl.protocol === 'http:') upstreamUrl.protocol = 'ws:';
      if (upstreamUrl.protocol === 'https:') upstreamUrl.protocol = 'wss:';
      const upgraded = server.upgrade(request, {
        data: {
          upstream: upstreamUrl.toString(),
          headers: authorizedHeaders(request),
          pending: [],
          upstreamOpen: false,
        },
      });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    if (isProxyPath(url.pathname)) return proxy(request, state.upstream);
    return serveAsset(request, state);
  };
}

export async function startBrowserHost(options: BrowserHostOptions = {}): Promise<BrowserHost> {
  const state = createBrowserHostState({
    directory: options.directory ?? directory,
    outputDirectory: options.outputDirectory ?? defaultOutputDirectory,
    upstream: options.upstream ?? defaultUpstream,
  });
  const development = options.development ?? true;
  // Observe edits made while the initial compilation is still running.
  const stopWatching: (() => void)[] = [];
  try {
    if (options.watch !== false) watchSources(state, development, stopWatching);
    if (options.buildOnStart !== false) await serializeBuild(state, development);
    const server = Bun.serve<ProxyData>({
      hostname: '127.0.0.1',
      port: options.port ?? defaultPort,
      fetch: createFetchHandler(state),
      websocket: {
        open(client) {
          const upstreamSocket = connectWebSocket(client.data.upstream, client.data.headers);
          client.data.socket = upstreamSocket;
          upstreamSocket.addEventListener('open', () => {
            client.data.upstreamOpen = true;
            flushPendingMessagesToUpstream(client.data);
          });
          upstreamSocket.addEventListener('message', (event) => client.send(event.data));
          upstreamSocket.addEventListener('close', (event) =>
            client.close(event.code, event.reason),
          );
          upstreamSocket.addEventListener('error', () =>
            client.close(1011, 'Upstream WebSocket error'),
          );
        },
        message(client, message) {
          const normalized = normalizeMessage(message);
          if (client.data.upstreamOpen) client.data.socket?.send(normalized);
          else client.data.pending.push(normalized);
        },
        close(client) {
          client.data.socket?.close();
        },
      },
    });

    return {
      server,
      url: server.url,
      close() {
        closeBrowserHostState(state);
        for (const stop of stopWatching) stop();
        void server.stop(true);
      },
    };
  } catch (error) {
    closeBrowserHostState(state);
    for (const stop of stopWatching) stop();
    throw error;
  }
}

if (import.meta.main) {
  const host = await startBrowserHost();
  const relativeOutputDirectory = relative(process.cwd(), defaultOutputDirectory);
  console.log(`weft-ui browser server listening on ${host.url}`);
  console.log(`serving Bun browser assets from ${relativeOutputDirectory}`);
}
