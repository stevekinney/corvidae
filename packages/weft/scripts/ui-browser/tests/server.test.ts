import { afterEach, expect, test } from 'bun:test';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_API_KEY } from '../dev-credentials.ts';
import {
  authorizedHeaders,
  buildWatchRoots,
  closeBrowserHostState,
  createBrowserHostState,
  flushPendingMessagesToUpstream,
  normalizeMessage,
  scheduleBuild,
  serializeBuild,
  startBrowserHost,
  type BrowserHost,
} from '../server.ts';

const cleanupTasks: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).toReversed()) {
    await cleanup();
  }
});

async function temporaryOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(`${tmpdir()}/weft-ui-browser-host-`);
  cleanupTasks.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function seedAssets(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), '<!doctype html><main>Weft UI</main>');
  await writeFile(join(directory, 'main.js'), 'console.log("weft-ui");');
}

function closeHost(host: BrowserHost): void {
  host.close();
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
      once: true,
    });
  });
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(event.data), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket message failed')), {
      once: true,
    });
  });
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for expected server observation.');
}

async function bytesFromMessage(message: unknown): Promise<number[]> {
  if (message instanceof ArrayBuffer) return [...new Uint8Array(message)];
  if (message instanceof Blob) return [...new Uint8Array(await message.arrayBuffer())];
  if (ArrayBuffer.isView(message)) {
    return [...new Uint8Array(message.buffer, message.byteOffset, message.byteLength)];
  }
  throw new Error(`Expected binary WebSocket message, received ${typeof message}.`);
}

function deferred(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
} {
  let rejectPromise: ((error: unknown) => void) | undefined;
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  if (rejectPromise === undefined || resolvePromise === undefined)
    throw new Error('Expected promise controls to be created.');
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

async function expectRejectedWith(
  errorPromise: Promise<unknown>,
  expectedError: Error,
): Promise<void> {
  try {
    await errorPromise;
  } catch (error) {
    expect(error).toBe(expectedError);
    return;
  }
  throw new Error('Expected promise to reject.');
}

test('buildWatchRoots includes the real Markdown package source root', () => {
  const browserDirectory = dirname(fileURLToPath(new URL('../server.ts', import.meta.url)));
  const roots = buildWatchRoots(browserDirectory);

  expect(roots).toContain(resolve(browserDirectory, '../../../../packages/markdown/src'));
  expect(roots).not.toContain(resolve(browserDirectory, '../../../markdown/src'));
});

test('authorizedHeaders preserves caller credentials and supplies the dev credential only when absent', () => {
  const ownCredential = authorizedHeaders(
    new Request('http://localhost/api/v1/workflows', {
      headers: { authorization: 'Bearer operator' },
    }),
  );
  const devCredential = authorizedHeaders(new Request('http://localhost/api/v1/workflows'));

  expect(ownCredential.get('authorization')).toBe('Bearer operator');
  expect(devCredential.get('authorization')).toBe(`Bearer ${DEV_API_KEY}`);
});

test('normalizeMessage preserves binary WebSocket frames as detached ArrayBuffers', () => {
  const source = new Uint8Array([1, 2, 3]);
  const normalized = normalizeMessage(source);

  expect(normalized).toBeInstanceOf(ArrayBuffer);
  expect([...new Uint8Array(normalized as ArrayBuffer)]).toEqual([1, 2, 3]);
});

test('flushPendingMessagesToUpstream forwards queued frames upstream instead of echoing them to the client', () => {
  const sent: ProxyMessage[] = [];
  const socket = {
    send(message: ProxyMessage) {
      sent.push(message);
    },
  } as unknown as WebSocket;
  const data = { pending: ['queued'], socket };

  flushPendingMessagesToUpstream(data);

  expect(sent).toEqual(['queued']);
  expect(data.pending).toEqual([]);
});

test('browser host proxies HTTP with authorization precedence and serves assets safely', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  await seedAssets(outputDirectory);
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return Response.json({ authorization: request.headers.get('authorization') });
    },
  });
  cleanupTasks.push(() => upstream.stop(true));

  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    upstream: upstream.url.origin,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));

  const proxied = await fetch(new URL('/api/v1/workflows', host.url));
  const proxiedWithCallerCredential = await fetch(new URL('/api/v1/workflows', host.url), {
    headers: { authorization: 'Bearer caller' },
  });
  const index = await fetch(host.url);
  const fallback = await fetch(new URL('/workflows/wf_1', host.url));
  const traversal = await fetch(new URL('/%2e%2e/server.ts', host.url));

  expect(await proxied.json()).toEqual({ authorization: `Bearer ${DEV_API_KEY}` });
  expect(await proxiedWithCallerCredential.json()).toEqual({ authorization: 'Bearer caller' });
  expect(index.status).toBe(200);
  expect(await index.text()).toContain('Weft UI');
  expect(fallback.status).toBe(200);
  expect(await fallback.text()).toContain('Weft UI');
  expect(traversal.status).toBe(404);
});

test('browser host fails closed when assets have not been built', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));

  const response = await fetch(host.url);

  expect(response.status).toBe(503);
  expect(await response.text()).toBe('Browser assets are not built.');
});

test('browser host returns a bounded client error for malformed encoded asset paths', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  await seedAssets(outputDirectory);
  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));

  const response = await fetch(new URL('/%E0%A4%A', host.url));

  expect(response.status).toBe(400);
  expect(await response.text()).toBe('Malformed asset path.');
});

test('serializeBuild queues a follow-up compilation when a rebuild is requested during an active build', async () => {
  const firstBuild = deferred();
  let buildCount = 0;
  const state = createBrowserHostState({
    buildAssets: async () => {
      buildCount += 1;
      if (buildCount === 1) await firstBuild.promise;
    },
  });

  const activeBuild = serializeBuild(state, true);
  expect(buildCount).toBe(1);
  const queuedBuild = serializeBuild(state, true);
  expect(buildCount).toBe(1);
  firstBuild.resolve();
  await activeBuild;
  await queuedBuild;

  expect(buildCount).toBe(2);
});

test('serializeBuild runs a queued repair compilation after an active build rejects', async () => {
  const firstBuild = deferred();
  let buildCount = 0;
  const state = createBrowserHostState({
    buildAssets: async () => {
      buildCount += 1;
      if (buildCount === 1) await firstBuild.promise;
    },
  });

  const activeBuild = serializeBuild(state, true);
  expect(buildCount).toBe(1);
  const queuedBuild = serializeBuild(state, true);
  firstBuild.reject(new Error('intermediate build failed'));
  await activeBuild;
  await queuedBuild;

  expect(buildCount).toBe(2);
  expect(state.build.status).toBe('idle');
});

test('serializeBuild reports the newest failed compilation after a queued repair fails', async () => {
  const firstBuild = deferred();
  const newestFailure = new Error('newest build failed');
  let buildCount = 0;
  const state = createBrowserHostState({
    buildAssets: async () => {
      buildCount += 1;
      if (buildCount === 1) await firstBuild.promise;
      else throw newestFailure;
    },
  });

  const activeBuild = serializeBuild(state, true);
  expect(buildCount).toBe(1);
  const queuedBuild = serializeBuild(state, true);
  firstBuild.reject(new Error('intermediate build failed'));
  await expectRejectedWith(activeBuild, newestFailure);
  await expectRejectedWith(queuedBuild, newestFailure);

  expect(buildCount).toBe(2);
  expect(state.build).toEqual({ status: 'failed', error: newestFailure });
});

test('closing browser host state clears a pending debounced rebuild before it can run', async () => {
  let buildCount = 0;
  const state = createBrowserHostState({
    buildAssets: async () => {
      buildCount += 1;
    },
  });

  scheduleBuild(state, true);
  closeBrowserHostState(state);
  await Bun.sleep(150);

  expect(buildCount).toBe(0);
});

test('browser host preserves upstream redirects for the client instead of following them', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  await seedAssets(outputDirectory);
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(null, {
        headers: { location: '/api/v1/workflows/wf_1' },
        status: 302,
      });
    },
  });
  cleanupTasks.push(() => upstream.stop(true));
  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    upstream: upstream.url.origin,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));

  const response = await fetch(new URL('/api/redirect', host.url), { redirect: 'manual' });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/api/v1/workflows/wf_1');
});

test('browser host cancels streaming upstream responses when the downstream reader cancels', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  await seedAssets(outputDirectory);
  let bodyCancelled = false;
  let signalAborted = false;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
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
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  cleanupTasks.push(() => upstream.stop(true));
  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    upstream: upstream.url.origin,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));

  const response = await fetch(new URL('/api/v1/events', host.url));
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Expected streaming response body.');
  const chunk = await reader.read();
  if (chunk.done) throw new Error('Expected initial SSE chunk.');
  await reader.cancel('test downstream cancellation');

  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(new TextDecoder().decode(chunk.value)).toBe('data: connected\n\n');
  await waitFor(() => (bodyCancelled && signalAborted ? true : undefined));
});

test('browser host strips encoded-body headers after Bun decodes upstream responses', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  await seedAssets(outputDirectory);
  const payload = 'proxied gzip payload';
  const compressed = Bun.gzipSync(new TextEncoder().encode(payload));
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(compressed, {
        headers: {
          'content-encoding': 'gzip',
          'content-length': String(compressed.byteLength),
          'content-type': 'text/plain;charset=utf-8',
        },
      });
    },
  });
  cleanupTasks.push(() => upstream.stop(true));
  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    upstream: upstream.url.origin,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));

  const response = await fetch(new URL('/api/gzip', host.url));

  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('content-length')).not.toBe(String(compressed.byteLength));
  expect(await response.text()).toBe(payload);
});

test('browser host proxies WebSocket text and binary frames to the upstream server', async () => {
  const outputDirectory = await temporaryOutputDirectory();
  await seedAssets(outputDirectory);
  const upstreamMessages: (string | number[])[] = [];
  const upstream = Bun.serve<{ authorization: string | null }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        server.upgrade(request, {
          data: { authorization: request.headers.get('authorization') },
        })
      ) {
        return undefined;
      }
      return new Response('Expected WebSocket upgrade', { status: 426 });
    },
    websocket: {
      message(socket, message) {
        if (typeof message === 'string') {
          upstreamMessages.push(message);
          socket.send(message);
          return;
        }
        const bytes = ArrayBuffer.isView(message)
          ? [...new Uint8Array(message.buffer, message.byteOffset, message.byteLength)]
          : [...new Uint8Array(message)];
        upstreamMessages.push(bytes);
        socket.send(message);
      },
    },
  });
  cleanupTasks.push(() => upstream.stop(true));
  const host = await startBrowserHost({
    buildOnStart: false,
    outputDirectory,
    port: 0,
    upstream: upstream.url.origin,
    watch: false,
  });
  cleanupTasks.push(() => closeHost(host));
  const client = new WebSocket(new URL('/api/v1/workflows/wf_1/watch', host.url).toString());
  cleanupTasks.push(() => client.close());
  await waitForOpen(client);

  client.send('hello');
  expect(await waitForMessage(client)).toBe('hello');
  client.send(new Uint8Array([4, 5, 6]));
  const binaryEcho = await waitForMessage(client);

  expect(await waitFor(() => upstreamMessages[0])).toBe('hello');
  expect(await waitFor(() => upstreamMessages[1])).toEqual([4, 5, 6]);
  expect(await bytesFromMessage(binaryEcho)).toEqual([4, 5, 6]);
});

type ProxyMessage = string | ArrayBuffer | Blob;

test('browser entrypoint watches survive repeated atomic saves', async () => {
  const directory = await temporaryOutputDirectory();
  const outputDirectory = join(directory, 'build');
  await writeFile(
    join(directory, 'index.html'),
    '<title>Initial</title><script type="module" src="./main.ts"></script>',
  );
  await writeFile(join(directory, 'main.ts'), 'document.title = "Initial";');
  const host = await startBrowserHost({ directory, outputDirectory, port: 0 });
  cleanupTasks.push(() => closeHost(host));

  for (const [filename, contents, marker] of [
    ['main.ts', 'document.title = "First save";', 'First save'],
    ['main.ts', 'document.title = "Second save";', 'Second save'],
    [
      'index.html',
      '<title>Saved HTML</title><script type="module" src="./main.ts"></script>',
      'Saved HTML',
    ],
  ] as const) {
    const emitted = Promise.withResolvers<string>();
    const readOutput = async () => {
      const html = await Bun.file(join(outputDirectory, 'index.html')).text();
      const script = html.match(/<script\b[^>]*src="([^"]+)"/)?.[1];
      if (script === undefined) throw new Error('Missing compiled browser entrypoint');
      return filename === 'index.html' ? html : Bun.file(join(outputDirectory, script)).text();
    };
    const observer = watch(outputDirectory, (_event, name) => {
      // Module provenance is written only after Bun has emitted every asset.
      if (name !== 'metafile.json') return;
      void readOutput().then((output) => {
        if (output.includes(marker)) emitted.resolve(output);
      }, emitted.reject);
    });
    cleanupTasks.push(() => observer.close());
    await writeFile(join(directory, `${filename}.saving`), contents);
    await rename(join(directory, `${filename}.saving`), join(directory, filename));
    expect(await emitted.promise).toContain(marker);
    observer.close();
  }
});

// The child process is the behavior under test (it must exit on its own after a startup failure),
// so it runs here at module scope, off the per-test clock, and the test only asserts. Its
// `timeout` is a hang detector, never a performance bound.
const startupFailure = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weft-ui-startup-failure-'));
  try {
    await writeFile(
      join(directory, 'index.html'),
      '<script type="module" src="./missing.ts"></script>',
    );
    const serverModule = fileURLToPath(new URL('../server.ts', import.meta.url));
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import { startBrowserHost } from ${JSON.stringify(serverModule)};
await startBrowserHost({ directory: ${JSON.stringify(directory)}, outputDirectory: ${JSON.stringify(join(directory, 'build'))}, port: 0 }).then(
  () => { throw new Error('Expected compilation to fail'); },
  () => { console.log('Startup rejected'); },
);`,
      ],
      { cwd: directory, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test('browser startup failure releases its watches without keeping the process alive', () => {
  expect(startupFailure.exitCode).toBe(0);
  expect(startupFailure.stdout).toContain('Startup rejected');
  expect(startupFailure.stderr).toBe('');
});
