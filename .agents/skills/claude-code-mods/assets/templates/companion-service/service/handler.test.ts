// Run with `bun test service` from the template directory. Nothing here starts
// a server: the handler is a function from Request to Response.
import { describe, expect, test } from 'bun:test';

import { compatibilityOf, parseHealth, parseItems } from '../plugin/hooks/protocol.ts';
import { createHandler } from './handler.ts';
import { createQueue } from './queue.ts';

const PORT = 47615;
const TOKEN = 'a'.repeat(64);

function setUp(limits?: Parameters<typeof createQueue>[0]) {
  let clock = 1_000;
  const handle = createHandler({
    queue: createQueue(limits),
    token: TOKEN,
    port: PORT,
    now: () => clock,
  });
  const call = (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    handle(
      new Request(`http://127.0.0.1:${PORT}${path}`, {
        method: init.method ?? 'GET',
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  return { call, advance: (milliseconds: number) => (clock += milliseconds) };
}

const ITEM = {
  id: 'ci-1',
  kind: 'failed-check',
  title: 'unit tests failed',
  source: 'ci',
  createdAt: 5,
};

describe('the service handler', () => {
  test('health names the service and protocol the mod expects, without a token', async () => {
    const { call } = setUp();
    const response = await call('/health', { headers: { authorization: '' } });
    expect(response.status).toBe(200);
    expect(compatibilityOf(parseHealth(await response.json()))).toBe('compatible');
  });

  test('refuses a missing or wrong token', async () => {
    const { call } = setUp();
    expect((await call('/v1/items', { headers: { authorization: '' } })).status).toBe(401);
    expect(
      (await call('/v1/items', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status,
    ).toBe(401);
  });

  test('refuses a foreign Host header and any browser Origin', async () => {
    const { call } = setUp();
    expect((await call('/health', { headers: { host: 'attacker.example:47615' } })).status).toBe(
      403,
    );
    expect(
      (await call('/health', { headers: { origin: 'https://attacker.example' } })).status,
    ).toBe(403);
  });

  test('a resubmitted item replaces itself and keeps its acknowledgement', async () => {
    const { call } = setUp();
    expect((await call('/v1/items', { method: 'POST', body: ITEM })).status).toBe(201);
    expect((await call('/v1/items/ci-1/acknowledge', { method: 'POST' })).status).toBe(200);
    expect(
      (await call('/v1/items', { method: 'POST', body: { ...ITEM, title: 'retried' } })).status,
    ).toBe(200);

    const listed = parseItems(await (await call('/v1/items')).json());
    expect(listed?.items).toHaveLength(1);
    expect(listed?.items[0]).toMatchObject({
      title: 'retried',
      createdAt: 5,
      acknowledgedAt: 1_000,
    });
  });

  test('acknowledging is idempotent and reports a missing item', async () => {
    const { call } = setUp();
    await call('/v1/items', { method: 'POST', body: ITEM });
    expect(await (await call('/v1/items/ci-1/acknowledge', { method: 'POST' })).json()).toEqual({
      status: 'acknowledged',
    });
    expect(await (await call('/v1/items/ci-1/acknowledge', { method: 'POST' })).json()).toEqual({
      status: 'already-acknowledged',
    });
    expect((await call('/v1/items/nope/acknowledge', { method: 'POST' })).status).toBe(404);
  });

  test('refuses malformed items and oversized bodies', async () => {
    const { call } = setUp();
    expect(
      (await call('/v1/items', { method: 'POST', body: { ...ITEM, kind: 'unknown' } })).status,
    ).toBe(400);
    expect(
      (await call('/v1/items', { method: 'POST', body: { ...ITEM, title: 'x'.repeat(70_000) } }))
        .status,
    ).toBe(413);
  });

  test('presence ignores a late heartbeat and expires a silent session', async () => {
    const { call, advance } = setUp();
    const beat = (sequence: number, instanceId = 'instance-1') =>
      call('/v1/presence/session-1', {
        method: 'PUT',
        body: { sessionId: 'session-1', instanceId, sequence, sentAt: 1 },
      });
    expect(await (await beat(2)).json()).toEqual({ status: 'recorded' });
    expect(await (await beat(1)).json()).toEqual({ status: 'stale' });
    expect(await (await beat(1, 'instance-2')).json()).toEqual({ status: 'recorded' });

    const live = await (await call('/v1/presence')).json();
    expect(live.sessions).toHaveLength(1);
    advance(60_000);
    expect((await (await call('/v1/presence')).json()).sessions).toHaveLength(0);
  });

  test('keeps the queue bounded, dropping acknowledged items first', async () => {
    const { call } = setUp({ maximumItems: 2, presenceLifetimeMilliseconds: 45_000 });
    await call('/v1/items', { method: 'POST', body: { ...ITEM, id: 'one', createdAt: 1 } });
    await call('/v1/items', { method: 'POST', body: { ...ITEM, id: 'two', createdAt: 2 } });
    await call('/v1/items/two/acknowledge', { method: 'POST' });
    await call('/v1/items', { method: 'POST', body: { ...ITEM, id: 'three', createdAt: 3 } });

    const listed = parseItems(await (await call('/v1/items')).json());
    expect(listed?.items.map((item) => item.id)).toEqual(['one', 'three']);
  });
});
