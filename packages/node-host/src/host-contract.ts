import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket as WebSocketClient } from 'ws';

type ContractSocket<Data> = {
  readonly data: Data;
  close(code?: number, reason?: string): void;
  send(message: string | ArrayBuffer | ArrayBufferView): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
};

type ContractOptions<Data> = {
  fetch(request: Request): Response | Promise<Response | undefined> | undefined;
  hostname?: string;
  port?: number;
  routes?: Record<string, Response | ((request: Request) => Response | Promise<Response>)>;
  websocket?: {
    maxPayloadLength?: number;
    message?(socket: ContractSocket<Data>, message: string | Uint8Array): void;
    open?(socket: ContractSocket<Data>): void;
  };
};

type ContractHost<Data> = {
  readonly hostname: string;
  readonly port: number;
  readonly url: URL;
  readonly ready?: Promise<void>;
  publish(topic: string, message: string | ArrayBuffer | ArrayBufferView): number;
  requestIP(request: Request): { address: string; family: string; port: number } | undefined;
  stop(closeActiveConnections?: boolean): void;
  timeout(request: Request, seconds: number): void;
  upgrade(request: Request, options: { data: Data }): boolean;
};

export type ContractHostFactory = <Data>(options: ContractOptions<Data>) => ContractHost<Data>;

async function open(socket: WebSocketClient): Promise<void> {
  await once(socket, 'open');
}

async function message(socket: WebSocketClient): Promise<{ binary: boolean; value: Buffer }> {
  const [value, binary] = (await once(socket, 'message')) as [Buffer, boolean];
  return { binary, value: Buffer.from(value) };
}

async function rejected(socket: WebSocketClient): Promise<{ body: string; status: number }> {
  return await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ body: Buffer.concat(chunks).toString(), status: response.statusCode ?? 0 }),
      );
    });
  });
}

function close(socket: WebSocketClient): Promise<number> {
  return once(socket, 'close').then(([code]) => code as number);
}

/** Registers the shared Bun and Node host behavior required by Corvidae server packages. */
export function hostContract(name: string, serve: ContractHostFactory): void {
  void test(`${name}: streams Fetch bodies and selects exact routes`, async () => {
    let requestedIP: { address: string; family: string; port: number } | undefined;
    let host: ContractHost<undefined>;
    host = serve({
      port: 0,
      fetch: async (request) => {
        requestedIP = host.requestIP(request);
        host.timeout(request, 1);
        return new Response(await request.text());
      },
      routes: { '/route': new Response('route') },
    });
    try {
      await host.ready;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('streamed '));
          controller.enqueue(new TextEncoder().encode('body'));
          controller.close();
        },
      });
      const streamed = await fetch(new URL('/fetch', host.url), {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit);
      assert.equal(await streamed.text(), 'streamed body');
      assert.ok(requestedIP?.address);
      assert.ok(requestedIP?.family === 'IPv4' || requestedIP?.family === 'IPv6');
      const route = await fetch(new URL('/route', host.url));
      assert.equal(await route.text(), 'route');
      const routeAgain = await fetch(new URL('/route', host.url));
      assert.equal(await routeAgain.text(), 'route');
    } finally {
      host.stop(true);
    }
  });

  void test(`${name}: returns a complete rejection response for an unupgraded socket`, async () => {
    const host = serve({
      port: 0,
      fetch: () => new Response('denied', { status: 403 }),
      websocket: {},
    });
    await host.ready;
    const socket = new WebSocketClient(host.url);
    try {
      assert.deepEqual(await rejected(socket), { body: 'denied', status: 403 });
    } finally {
      host.stop(true);
    }
  });

  void test(`${name}: upgrades with data and echoes text and binary messages`, async () => {
    let host: ContractHost<{ name: string }>;
    const opened: string[] = [];
    host = serve({
      port: 0,
      fetch(request) {
        return host.upgrade(request, { data: { name: 'socket' } })
          ? undefined
          : new Response('missing', { status: 404 });
      },
      websocket: {
        message(socket, value) {
          socket.send(value);
        },
        open(socket) {
          opened.push(socket.data.name);
        },
      },
    });
    await host.ready;
    const socket = new WebSocketClient(host.url);
    try {
      await open(socket);
      assert.deepEqual(opened, ['socket']);
      socket.send('text');
      const text = await message(socket);
      assert.equal(text.binary, false);
      assert.equal(text.value.toString(), 'text');
      socket.send(Buffer.from([1, 2, 3]));
      const binary = await message(socket);
      assert.equal(binary.binary, true);
      assert.deepEqual([...binary.value], [1, 2, 3]);
    } finally {
      host.stop(true);
    }
  });

  void test(`${name}: fans out publications and excludes an unsubscribed socket`, async () => {
    let host: ContractHost<undefined>;
    host = serve({
      port: 0,
      fetch(request) {
        return host.upgrade(request, { data: undefined }) ? undefined : new Response('missing');
      },
      websocket: {
        message(socket, value) {
          if (value === 'unsubscribe') {
            socket.unsubscribe('updates');
            socket.send('unsubscribed');
          }
        },
        open(socket) {
          socket.subscribe('updates');
        },
      },
    });
    await host.ready;
    const first = new WebSocketClient(host.url);
    const second = new WebSocketClient(host.url);
    try {
      await Promise.all([open(first), open(second)]);
      const bothFirst = message(first);
      const bothSecond = message(second);
      assert.ok(host.publish('updates', 'both') > 0);
      const firstMessage = await bothFirst;
      const secondMessage = await bothSecond;
      assert.equal(firstMessage.value.toString(), 'both');
      assert.equal(secondMessage.value.toString(), 'both');
      first.send('unsubscribe');
      const unsubscribed = await message(first);
      assert.equal(unsubscribed.value.toString(), 'unsubscribed');
      const secondOnly = message(second);
      assert.ok(host.publish('updates', 'second only') > 0);
      const secondOnlyMessage = await secondOnly;
      assert.equal(secondOnlyMessage.value.toString(), 'second only');
    } finally {
      host.stop(true);
    }
  });

  void test(`${name}: closes oversized messages with 1009`, async () => {
    let host: ContractHost<undefined>;
    host = serve({
      port: 0,
      fetch(request) {
        return host.upgrade(request, { data: undefined }) ? undefined : new Response('missing');
      },
      websocket: { maxPayloadLength: 4 },
    });
    await host.ready;
    const socket = new WebSocketClient(host.url);
    try {
      await open(socket);
      socket.send('oversized');
      assert.equal(await close(socket), 1009);
    } finally {
      host.stop(true);
    }
  });

  void test(`${name}: stop(true) closes open sockets`, async () => {
    let host: ContractHost<undefined>;
    host = serve({
      port: 0,
      fetch(request) {
        return host.upgrade(request, { data: undefined }) ? undefined : new Response('missing');
      },
      websocket: {},
    });
    await host.ready;
    const socket = new WebSocketClient(host.url);
    await open(socket);
    const closed = close(socket);
    host.stop(true);
    assert.notEqual(await closed, 1000);
  });
}
