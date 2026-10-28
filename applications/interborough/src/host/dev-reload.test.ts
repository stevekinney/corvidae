import { describe, expect, test } from 'bun:test';

import {
  createDevReload,
  DEV_RELOAD_CLIENT,
  DEV_RELOAD_ROUTE,
  injectDevReloadClient,
} from './dev-reload.ts';

const decoder = new TextDecoder();

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return decoder.decode(chunk.value);
}

describe('createDevReload', () => {
  test('opens an event stream and greets the page before any rebuild', async () => {
    const reload = createDevReload();
    const response = reload.connect();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    expect(await readText(reader)).toBe(': connected\n\n');
    expect(reload.connectionCount()).toBe(1);
    await reader.cancel();
  });

  test('sends one reload event to every connected page after a rebuild', async () => {
    const reload = createDevReload();
    const readers = [reload.connect(), reload.connect()].map((response) =>
      response.body!.getReader(),
    );
    for (const reader of readers) await readText(reader);

    reload.notify();

    for (const reader of readers) {
      expect(await readText(reader)).toBe('event: reload\ndata: 1\n\n');
      await reader.cancel();
    }
  });

  test('does not replay a rebuild to a page that connected after it', async () => {
    const reload = createDevReload();
    reload.notify();
    const reader = reload.connect().body!.getReader();
    expect(await readText(reader)).toBe(': connected\n\n');

    // The first event this page can receive is the next rebuild's, not the one it missed.
    reload.notify();
    expect(await readText(reader)).toBe('event: reload\ndata: 2\n\n');
    await reader.cancel();
  });

  test('forgets a connection its page closed and writes nothing to it afterwards', async () => {
    const reload = createDevReload();
    const gone = reload.connect().body!.getReader();
    const kept = reload.connect().body!.getReader();
    await readText(gone);
    await readText(kept);
    expect(reload.connectionCount()).toBe(2);

    await gone.cancel();
    expect(reload.connectionCount()).toBe(1);

    expect(() => reload.notify()).not.toThrow();
    expect(await readText(kept)).toBe('event: reload\ndata: 1\n\n');
    await kept.cancel();
    expect(reload.connectionCount()).toBe(0);
  });

  test('ends every stream on close and refuses a page that arrives after', async () => {
    const reload = createDevReload();
    const readers = [reload.connect(), reload.connect()].map((response) =>
      response.body!.getReader(),
    );
    for (const reader of readers) await readText(reader);

    reload.close();

    expect(reload.connectionCount()).toBe(0);
    for (const reader of readers) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(true);
    }
    expect(reload.connect().status).toBe(503);
    expect(() => reload.notify()).not.toThrow();
    expect(() => reload.close()).not.toThrow();
  });
});

describe('injectDevReloadClient', () => {
  test('places the client script before the closing body tag', () => {
    const html = '<!doctype html><body><div id="app"></div></body>';
    const injected = injectDevReloadClient(html);
    expect(injected).toContain(DEV_RELOAD_CLIENT);
    expect(injected.indexOf(DEV_RELOAD_CLIENT)).toBeLessThan(injected.indexOf('</body>'));
    expect(injected.startsWith('<!doctype html><body><div id="app"></div>')).toBe(true);
    expect(injected.endsWith('</body>')).toBe(true);
  });

  test('appends the client script to a page with no body tag', () => {
    expect(injectDevReloadClient('<div id="app"></div>')).toContain(DEV_RELOAD_CLIENT);
  });

  test('names the route the host serves', () => {
    expect(DEV_RELOAD_CLIENT).toContain(JSON.stringify(DEV_RELOAD_ROUTE));
  });
});
