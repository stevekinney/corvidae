/**
 * The browser's door to the Bureau's hooks (COR-1858): each call sends exactly what the editor
 * means, and an answer is parsed at the boundary, so a hook or a delivery that the Bureau shaped
 * differently is refused instead of read wrongly.
 */
import { throwingRejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createHook,
  deleteHook,
  getHook,
  listHookDeliveries,
  listHookEventKinds,
  listHooks,
  testHook,
  updateHook,
} from './bureau-hooks.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const HOOK = {
  id: 'hook-1',
  owner: 'anonymous:local',
  name: null,
  action: { type: 'webhook', url: 'https://example.com/a' },
  events: ['review.requested'],
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  revision: 1,
};

const DELIVERY = {
  id: 'delivery-1',
  hookId: 'hook-1',
  owner: 'anonymous:local',
  actionType: 'webhook',
  kind: 'hook.test',
  test: true,
  status: 'delivered',
  request: { url: 'https://example.com/a', headers: { 'x-delivery-id': 'd' }, body: '{}' },
  work: null,
  attempts: [
    {
      number: 1,
      startedAt: 1,
      finishedAt: 2,
      outcome: 'response',
      status: 200,
      responseExcerpt: 'ok',
      responseTruncated: false,
      error: null,
      receipt: null,
    },
  ],
  maxAttempts: 5,
  createdAt: 1,
  updatedAt: 2,
};

describe('the Bureau’s hooks', () => {
  test('are listed and read by their identifier', async () => {
    stub = installBureauStub({
      'bureau.hooks.list': () => ({ hooks: [HOOK] }),
      'bureau.hooks.get': () => HOOK,
    });
    const listed = await listHooks();
    const read = await getHook('hook-1');
    expect(listed.map((hook) => hook.id)).toEqual(['hook-1']);
    expect(read).toMatchObject({ id: 'hook-1', action: HOOK.action, revision: 1 });
    expect(stub.callsTo('bureau.hooks.get')[0]?.params).toEqual({ hookId: 'hook-1' });
  });

  test('read an action of every kind, a plugin’s included', async () => {
    const actions = [
      { type: 'start-workflow', workflowId: 'digest', input: 'event' },
      { type: 'notify', title: null },
      { type: 'plugin', plugin: 'acme', kind: 'page', configuration: { channel: 'ops' } },
    ];
    stub = installBureauStub({
      'bureau.hooks.list': () => ({ hooks: actions.map((action) => ({ ...HOOK, action })) }),
    });
    const hooks = await listHooks();
    expect(hooks.map((hook) => hook.action.type)).toEqual(['start-workflow', 'notify', 'plugin']);
  });

  test('refuse an answer of a shape the browser does not know', async () => {
    stub = installBureauStub({
      'bureau.hooks.get': () => ({ ...HOOK, action: { type: 'carrier-pigeon' } }),
      'bureau.hooks.list': () => ({ hooks: [{ ...HOOK, revision: 'one' }] }),
    });
    expect(await throwingRejectionOf(getHook('hook-1'))).toThrow();
    expect(await throwingRejectionOf(listHooks())).toThrow();
  });

  test('are created from the events, the action, and the secret, which goes out and never comes back', async () => {
    stub = installBureauStub({ 'bureau.hooks.create': () => HOOK });
    const made = await createHook({
      name: 'Tell it',
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/a' },
      signingSecret: 'sixteen-characters-or-more',
    });
    expect(stub.callsTo('bureau.hooks.create')[0]?.params).toEqual({
      name: 'Tell it',
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/a' },
      signingSecret: 'sixteen-characters-or-more',
    });
    expect(JSON.stringify(made)).not.toContain('sixteen-characters');
  });

  test('are changed against the revision that was read', async () => {
    stub = installBureauStub({
      'bureau.hooks.update': () => ({ ...HOOK, enabled: false, revision: 2 }),
    });
    const changed = await updateHook('hook-1', 1, { enabled: false, name: null });
    expect(stub.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'hook-1',
      expectedRevision: 1,
      enabled: false,
      name: null,
    });
    expect(changed.revision).toBe(2);
  });

  test('are deleted by their identifier', async () => {
    stub = installBureauStub({
      'bureau.hooks.delete': () => ({ hookId: 'hook-1', deleted: true }),
    });
    await deleteHook('hook-1');
    expect(stub.callsTo('bureau.hooks.delete')[0]?.params).toEqual({ hookId: 'hook-1' });
  });

  test('are tested with one call, which answers the delivery it made', async () => {
    stub = installBureauStub({ 'bureau.hooks.test': () => DELIVERY });
    const sent = await testHook('hook-1');
    expect(sent.test).toBe(true);
    expect(sent.attempts[0]?.status).toBe(200);
    expect(stub.callsTo('bureau.hooks.test')[0]?.params).toEqual({ hookId: 'hook-1' });
  });

  test('list their newest deliveries, at most the number asked for', async () => {
    stub = installBureauStub({ 'bureau.hooks.deliveries': () => ({ deliveries: [DELIVERY] }) });
    expect(await listHookDeliveries('hook-1', 20)).toHaveLength(1);
    expect(stub.callsTo('bureau.hooks.deliveries')[0]?.params).toEqual({
      hookId: 'hook-1',
      limit: 20,
    });
  });

  test('offer the events the Bureau describes, with where each can come from', async () => {
    stub = installBureauStub({
      'bureau.events.catalog': () => ({
        events: [
          {
            kind: 'schedule.missed',
            description: 'A fire did not happen.',
            origin: 'external',
            payload: [],
          },
        ],
      }),
    });
    expect(await listHookEventKinds()).toEqual([
      { kind: 'schedule.missed', description: 'A fire did not happen.', origin: 'external' },
    ]);
  });
});
