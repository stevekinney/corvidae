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
  scope: null,
  lastDelivery: null,
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
  test('asks the Bureau for one subject’s hooks, and reads each hook’s last delivery', async () => {
    const lastDelivery = {
      id: 'delivery-1',
      kind: 'review.requested',
      test: false,
      status: 'exhausted',
      lastAttempt: {
        number: 2,
        startedAt: 1,
        finishedAt: 2,
        outcome: 'network-error',
        status: null,
        error: 'connect refused',
      },
      createdAt: 1,
      updatedAt: 2,
    };
    stub = installBureauStub({
      'bureau.hooks.list': () => ({
        hooks: [{ ...HOOK, scope: { kind: 'agent', id: 'scout' }, lastDelivery }],
      }),
    });
    const listed = await listHooks({ scope: { kind: 'agent', id: 'scout' } });
    expect(stub.callsTo('bureau.hooks.list')[0]?.params).toEqual({
      scope: { kind: 'agent', id: 'scout' },
    });
    expect(listed[0]?.lastDelivery).toEqual(lastDelivery as never);

    await listHooks();
    expect(stub.callsTo('bureau.hooks.list')[1]?.params).toEqual({});
  });

  test('keeps a stored scope of a kind this page does not know, rather than failing the list', async () => {
    stub = installBureauStub({
      'bureau.hooks.list': () => ({ hooks: [{ ...HOOK, scope: { kind: 'team', id: 'blue' } }] }),
    });
    const listed = await listHooks();
    expect(listed[0]?.scope).toEqual({ kind: 'team', id: 'blue' });
  });

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

  test('keep the request a delivery sent, its body included, and when its next try is due (COR-2022)', async () => {
    const body = JSON.stringify({
      id: 'delivery-1',
      hookId: 'hook-1',
      kind: 'run.error',
      payload: { runId: 'run-7', step: 2, error: 'GitHub didn’t answer (HTTP 503)' },
    });
    stub = installBureauStub({
      'bureau.hooks.deliveries': () => ({
        deliveries: [
          {
            ...DELIVERY,
            status: 'pending',
            request: { ...DELIVERY.request, body },
            nextAttemptAt: 40_000,
          },
          DELIVERY,
        ],
      }),
    });
    const [waiting, settled] = await listHookDeliveries('hook-1', 20);

    expect(waiting?.request).toEqual({
      url: 'https://example.com/a',
      headers: { 'x-delivery-id': 'd' },
      body,
    });
    expect(waiting?.nextAttemptAt).toBe(40_000);
    expect(deliveryBody(waiting!)).toMatchObject({
      kind: 'run.error',
      payload: { runId: 'run-7', error: 'GitHub didn’t answer (HTTP 503)' },
    });
    // A delivery with no try due, and one from a Bureau that predates the field, read alike.
    expect(settled?.nextAttemptAt).toBeNull();
    expect(deliveryBody({ request: null })).toBeUndefined();
    expect(deliveryBody({ request: { url: 'u', headers: {}, body: 'not json' } })).toBeUndefined();
  });

  test('refuse a delivery whose request has no body, rather than show a payload that is not there', async () => {
    stub = installBureauStub({
      'bureau.hooks.deliveries': () => ({
        deliveries: [{ ...DELIVERY, request: { url: 'https://example.com/a' } }],
      }),
    });
    expect(await throwingRejectionOf(listHookDeliveries('hook-1', 20))).toThrow();
  });

  test('carry a generated signing secret on the create answer alone, and null when the person chose it', async () => {
    stub = installBureauStub({
      'bureau.hooks.create': (params) =>
        params['signingSecret'] === undefined
          ? { ...HOOK, signingSecret: 'whsec_3f9a1c0d7e5b4a62c8d1e0f9' }
          : { ...HOOK, signingSecret: null },
      'bureau.hooks.get': () => HOOK,
    });
    const generated = await createHook({
      events: ['run.error'],
      action: { type: 'webhook', url: 'https://example.com/a' },
    });
    expect(generated.signingSecret).toBe('whsec_3f9a1c0d7e5b4a62c8d1e0f9');
    const chosen = await createHook({
      events: ['run.error'],
      action: { type: 'webhook', url: 'https://example.com/a' },
      signingSecret: 'sixteen-characters-or-more',
    });
    expect(chosen.signingSecret).toBeNull();
    // A read never carries one.
    expect(await getHook('hook-1')).not.toHaveProperty('signingSecret');
  });

  test('replace a signing secret against the revision that was read, answering the new one once', async () => {
    stub = installBureauStub({
      'bureau.hooks.secret.replace': () => ({
        ...HOOK,
        revision: 2,
        signingSecret: 'whsec_0123456789abcdef01234567',
      }),
    });
    const replaced = await replaceHookSecret('hook-1', 1);
    expect(replaced.signingSecret).toBe('whsec_0123456789abcdef01234567');
    expect(replaced.revision).toBe(2);
    expect(stub.callsTo('bureau.hooks.secret.replace')[0]?.params).toEqual({
      hookId: 'hook-1',
      expectedRevision: 1,
    });

    await replaceHookSecret('hook-1');
    expect(stub.callsTo('bureau.hooks.secret.replace')[1]?.params).toEqual({ hookId: 'hook-1' });
  });

  test('refuse a replaced-secret answer that carries no secret', async () => {
    stub = installBureauStub({ 'bureau.hooks.secret.replace': () => HOOK });
    expect(await throwingRejectionOf(replaceHookSecret('hook-1'))).toThrow();
  });

  test('test a webhook before it is saved, sending only the URL and the secret the person chose', async () => {
    const draft = { ...DELIVERY, hookId: 'draft', maxAttempts: 1 };
    stub = installBureauStub({ 'bureau.hooks.draft.test': () => draft });

    const sent = await testHookDraft({ url: 'https://hooks.example.com/in' });
    expect(sent).toMatchObject({ hookId: 'draft', status: 'delivered' });
    expect(sent.attempts[0]?.status).toBe(200);
    expect(stub.callsTo('bureau.hooks.draft.test')[0]?.params).toEqual({
      url: 'https://hooks.example.com/in',
    });

    await testHookDraft({
      url: 'https://hooks.example.com/in',
      signingSecret: 'sixteen-characters-or-more',
    });
    expect(stub.callsTo('bureau.hooks.draft.test')[1]?.params).toEqual({
      url: 'https://hooks.example.com/in',
      signingSecret: 'sixteen-characters-or-more',
    });
  });

  test('retry one delivery of one hook, and answer its record', async () => {
    stub = installBureauStub({
      'bureau.hooks.deliveries.retry': () => ({
        ...DELIVERY,
        status: 'pending',
        maxAttempts: 2,
        nextAttemptAt: null,
      }),
    });
    const retried = await retryHookDelivery('hook-1', 'delivery-1');
    expect(retried).toMatchObject({ id: 'delivery-1', status: 'pending', maxAttempts: 2 });
    expect(stub.callsTo('bureau.hooks.deliveries.retry')[0]?.params).toEqual({
      hookId: 'hook-1',
      deliveryId: 'delivery-1',
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
            scopes: ['schedule'],
          },
        ],
      }),
    });
    expect(await listHookEventKinds()).toEqual([
      {
        kind: 'schedule.missed',
        description: 'A fire did not happen.',
        origin: 'external',
        scopes: ['schedule'],
      },
    ]);
  });
});
