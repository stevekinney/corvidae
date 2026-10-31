/**
 * COR-1858: the host turns Bureau hooks on for a home that runs on the person's own machine. Every
 * test starts the real host and talks to it over its own HTTP surface, with a receiver of its own
 * standing in for the web address a hook sends to.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];
const receivers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const receiver of receivers.splice(0)) await receiver.stop(true);
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(): Promise<Host> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-hooks-'));
  directories.push(directory);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: directory }, port: 0 });
  hosts.push(host);
  return host;
}

type Received = { headers: Headers; body: string };

/** A receiver that answers every request `200` and keeps what it was sent. */
function receiver(): { url: string; received: Received[] } {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      received.push({ headers: request.headers, body: await request.text() });
      return new Response('ok');
    },
  });
  receivers.push(server);
  return { url: `http://127.0.0.1:${String(server.port)}/receive`, received };
}

async function call(host: Host, method: string, params: Record<string, unknown>) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  return (await response.json()) as { result?: any; error?: any };
}

describe('hooks on a home that runs on the person’s own machine', () => {
  test('are on: a hook made through the host is listed, tested, and its delivery is kept', async () => {
    const host = await start();
    expect(host.bureau.hooks).toBeDefined();
    const target = receiver();

    const created = await call(host, 'bureau.hooks.create', {
      name: 'Tell the receiver',
      events: ['review.requested'],
      action: { type: 'webhook', url: target.url },
      signingSecret: 'a-signing-secret-of-twenty-chars',
    });
    expect(created.error).toBeUndefined();
    const hookId = created.result.id as string;
    // The secret goes in and never comes back.
    expect(JSON.stringify(created.result)).not.toContain('a-signing-secret');

    const listed = await call(host, 'bureau.hooks.list', {});
    expect(listed.result.hooks.map((hook: { id: string }) => hook.id)).toEqual([hookId]);

    const tested = await call(host, 'bureau.hooks.test', { hookId });
    expect(tested.result.status).toBe('delivered');
    expect(tested.result.test).toBe(true);
    // The receiver got one signed request carrying the test event.
    expect(target.received).toHaveLength(1);
    expect(target.received[0]?.headers.get('x-signature')).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
    expect(JSON.parse(target.received[0]?.body ?? '{}')).toMatchObject({
      hookId,
      kind: 'hook.test',
      test: true,
    });

    const deliveries = await call(host, 'bureau.hooks.deliveries', { hookId, limit: 20 });
    expect(deliveries.result.deliveries).toHaveLength(1);
    expect(deliveries.result.deliveries[0]).toMatchObject({
      hookId,
      status: 'delivered',
      attempts: [{ outcome: 'response', status: 200 }],
    });
  });

  test('describe every event a hook can listen to', async () => {
    const host = await start();
    const catalog = await call(host, 'bureau.events.catalog', {});
    const kinds = catalog.result.events.map((event: { kind: string }) => event.kind);
    expect(kinds).toContain('review.requested');
    expect(kinds).toContain('schedule.missed');
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
