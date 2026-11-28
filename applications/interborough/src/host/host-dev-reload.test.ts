import { buildProduction } from '@lostgradient/velveteen/build';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stubBrowserPublication } from './build-info.test-support.ts';
import { DEV_RELOAD_CLIENT, DEV_RELOAD_ROUTE } from './dev-reload.ts';
import { startHost, type Host } from './host.ts';
import {
  NATIVE_DOCUMENT_DIRECTORY,
  openDevelopmentNativeDocuments,
  openPublishedNativeDocuments,
} from './native-document-path.ts';

const directories: string[] = [];
const hosts: Host[] = [];

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const project = join(import.meta.dir, '../..');
await mkdir(join(project, '.cache'), { recursive: true });
const fixtures = await mkdtemp(join(project, '.cache/dev-document-'));
afterAll(() => rm(fixtures, { recursive: true, force: true }));
const publishedDocuments = (async () => {
  const routes = join(fixtures, 'routes');
  for (const path of ['', 'chats', 'runs/[run]']) {
    const directory = join(routes, path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '+page.svelte'), '<main>Native test document</main>');
  }
  const output = join(fixtures, 'output');
  await buildProduction({
    projectDirectory: project,
    routesDirectory: routes,
    outputDirectory: join(output, NATIVE_DOCUMENT_DIRECTORY),
  });
  return output;
})();

async function start(development: boolean): Promise<Host> {
  const home = await scratch('interborough-dev-home-');
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    openDocumentCandidate: async () =>
      openPublishedNativeDocuments(await publishedDocuments, development),
    ...(development ? { development } : {}),
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const decoder = new TextDecoder();

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return decoder.decode(chunk.value);
}

/** Open the reload stream the way a page's `EventSource` does, and read its greeting. */
async function openStream(host: Host): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(new URL(DEV_RELOAD_ROUTE, host.url), {
    headers: { accept: 'text/event-stream' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  expect(await readText(reader)).toBe(': connected\n\n');
  return reader;
}

describe('the development host', () => {
  test('injects the reload client at every native document route', async () => {
    const host = await start(true);
    for (const path of ['/', '/chats', '/runs/abc']) {
      const response = await fetch(new URL(path, host.url));
      const html = await response.text();
      expect(html, path).toContain(DEV_RELOAD_CLIENT);
      expect(html, path).toContain('<main>Native test document</main>');
    }
  });

  test('sends a connected page one reload event after a rebuild', async () => {
    const host = await start(true);
    const reader = await openStream(host);
    host.notifyRebuilt();
    expect(await readText(reader)).toBe('event: reload\ndata: 1\n\n');
    await reader.cancel();
  });

  test('does not send a stale reload to a page that connects after a rebuild', async () => {
    const host = await start(true);
    host.notifyRebuilt();
    const reader = await openStream(host);
    host.notifyRebuilt();
    expect(await readText(reader)).toBe('event: reload\ndata: 2\n\n');
    await reader.cancel();
  });

  test('ends the open reload streams when the host closes, so it exits cleanly', async () => {
    const host = await start(true);
    const reader = await openStream(host);
    const ended = reader.read();
    await host.close();
    // The stream ends (or errors, if the socket is cut first) instead of hanging the reader.
    const outcome = await ended.then(
      (chunk) => chunk.done,
      () => true,
    );
    expect(outcome).toBe(true);
  });

  test('keeps notifying after a page has gone away', async () => {
    const host = await start(true);
    const gone = await openStream(host);
    const kept = await openStream(host);
    await gone.cancel();
    host.notifyRebuilt();
    expect(await readText(kept)).toBe('event: reload\ndata: 1\n\n');
    await kept.cancel();
  });
});

describe('a host that is not the development host', () => {
  test('answers the reload route with 404', async () => {
    const host = await start(false);
    for (const accept of ['text/event-stream', 'text/html']) {
      const response = await fetch(new URL(DEV_RELOAD_ROUTE, host.url), { headers: { accept } });
      expect(response.status, accept).toBe(404);
    }
  });

  test('serves the published document with no reload client, and ignores a rebuild notice', async () => {
    const host = await start(false);
    expect(() => host.notifyRebuilt()).not.toThrow();
    const response = await fetch(new URL('/', host.url));
    const html = await response.text();
    expect(html).not.toContain(DEV_RELOAD_CLIENT);
    expect(html).not.toContain(DEV_RELOAD_ROUTE);
    expect(html).toContain('<main>Native test document</main>');
    expect(html).toContain('id="velveteen-data"');
  });
});

test('a development publication preserves live responses and the previous hashed assets', async () => {
  const root = await scratch('interborough-native-publication-');
  const routes = join(fixtures, 'retirement-routes');
  const stream = join(routes, 'stream');
  await mkdir(stream, { recursive: true });
  async function publish(label: string) {
    await Bun.write(join(routes, '+page.svelte'), `<main>Generation ${label}</main>`);
    await Bun.write(
      join(stream, '+server.ts'),
      `export function GET() {
        const chunks = ['${label}-first', '${label}-last'];
        return new Response(new ReadableStream({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(chunk));
          },
        }, { highWaterMark: 0 }));
      }`,
    );
    const directory = stubBrowserPublication(root);
    return buildProduction({
      projectDirectory: project,
      routesDirectory: routes,
      outputDirectory: join(directory, NATIVE_DOCUMENT_DIRECTORY),
    });
  }

  const first = await publish('one');
  const documents = await openDevelopmentNativeDocuments(root);
  const request = (path: string) => new Request(new URL(path, 'http://127.0.0.1'));
  try {
    const originalResponse = await documents.fetch(request('/stream'));
    const originalSource = originalResponse.body!.getReader();
    expect(await readText(originalSource)).toBe('one-first');

    const next = await publish('two');
    const newAssetUrls = new Set(next.manifest.assets.map(({ url }) => url));
    const retiredAsset = first.manifest.assets.find(({ url }) => !newAssetUrls.has(url));
    expect(retiredAsset).toBeDefined();
    await documents.refresh();

    const fresh = await documents.fetch(request('/'));
    expect(await fresh.text()).toContain('Generation two');
    expect(await readText(originalSource)).toBe('one-last');
    const end = await originalSource.read();
    expect(end.done).toBe(true);
    const asset = await documents.fetch(request(retiredAsset!.url));
    expect(asset.status).toBe(200);
    const bytes = await asset.arrayBuffer();
    expect(bytes.byteLength).toBe(retiredAsset!.bytes);
  } finally {
    await documents.dispose();
  }
});
