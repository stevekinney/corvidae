import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEV_RELOAD_CLIENT, DEV_RELOAD_ROUTE } from './dev-reload.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function createBuild(): Promise<string> {
  const build = await scratch('interborough-dev-build-');
  await mkdir(join(build, 'assets'));
  await writeFile(
    join(build, 'index.html'),
    '<!doctype html><html><body><div id="app"></div></body></html>',
  );
  return build;
}

async function start(development: boolean): Promise<Host> {
  const home = await scratch('interborough-dev-home-');
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    buildDirectory: await createBuild(),
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
  test('injects the reload client into index.html at every client route', async () => {
    const host = await start(true);
    for (const path of ['/', '/chat', '/runs/abc']) {
      const response = await fetch(new URL(path, host.url));
      const html = await response.text();
      expect(html, path).toContain(DEV_RELOAD_CLIENT);
      expect(html, path).toContain('<div id="app"></div>');
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

  test('serves index.html as built, with no reload client, and ignores a rebuild notice', async () => {
    const host = await start(false);
    expect(() => host.notifyRebuilt()).not.toThrow();
    const response = await fetch(new URL('/', host.url));
    const html = await response.text();
    expect(html).not.toContain(DEV_RELOAD_CLIENT);
    expect(html).not.toContain(DEV_RELOAD_ROUTE);
    expect(html).toBe('<!doctype html><html><body><div id="app"></div></body></html>');
  });
});
