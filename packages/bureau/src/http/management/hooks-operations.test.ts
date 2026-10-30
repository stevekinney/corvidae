/**
 * COR-1939 — `bureau.hooks.*` over a real Bureau and its handler: who may create, read, change,
 * test and delete a hook and see its deliveries, the shapes returned, and the typed faults.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import { createReceiver, SIGNING_SECRET } from '../../hooks/hooks.test-support.ts';
import { HOOK_DELIVERY_KEY_PREFIX } from '../../hooks/hook-store.ts';
import type { HookDeliveryRecord, HookSecretStore } from '../../hooks/hook-types.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { bureauHooksOperations } from './hooks-operations.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function open(
  options: { secrets?: HookSecretStore; withoutHooks?: boolean; storage?: MemoryStorage } = {},
) {
  const receiver = createReceiver((_call, index) =>
    index === 0 ? new Response('pong', { status: 200 }) : new Response('again'),
  );
  const opened: OpenedBureau = await openBureau({
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    bureauOptions: {
      ...(options.withoutHooks === true
        ? {}
        : {
            hooks: options.secrets === undefined ? {} : { secrets: options.secrets },
            answerEncryption: { current: await generateEncryptionKey() },
          }),
      webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
    },
  });
  cleanups.push(() => opened.dispose());
  return { opened, receiver };
}

const call = (opened: OpenedBureau, method: string, params: unknown, key: string) =>
  rpc(opened.handler, method, params, key);

const NEW_HOOK = {
  url: 'https://receiver.example/hook',
  events: ['run.settled'],
  signingSecret: SIGNING_SECRET,
};

async function resultOf(opened: OpenedBureau, method: string, params: unknown, key: string) {
  const body = await call(opened, method, params, key);
  return body.result;
}

async function errorOf(opened: OpenedBureau, method: string, params: unknown, key: string) {
  const body = await call(opened, method, params, key);
  return body.error;
}

async function createAs(opened: OpenedBureau, key: string, params: object = {}) {
  const created = await call(opened, 'bureau.hooks.create', { ...NEW_HOOK, ...params }, key);
  expect(created.error).toBeUndefined();
  return created.result as { id: string; owner: string };
}

describe('bureau.hooks.*', () => {
  it('serves the seven operations, each described, with only delete destructive', () => {
    expect(bureauHooksOperations.map((operation) => operation.name)).toEqual([
      'bureau.hooks.create',
      'bureau.hooks.update',
      'bureau.hooks.delete',
      'bureau.hooks.get',
      'bureau.hooks.list',
      'bureau.hooks.test',
      'bureau.hooks.deliveries',
    ]);
    for (const operation of bureauHooksOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
      expect(operation.description?.length ?? 0).toBeGreaterThan(40);
    }
    expect(
      bureauHooksOperations.filter((operation) => operation.destructive).map((o) => o.name),
    ).toEqual(['bureau.hooks.delete']);
  });

  it('creates a hook owned by the caller, and never returns the signing secret', async () => {
    const { opened } = await open();
    const created = await call(opened, 'bureau.hooks.create', NEW_HOOK, 'alice-observer-key');
    expect(created.error).toBeUndefined();
    expect(created.result).toMatchObject({
      owner: 'api-key:alice',
      action: { type: 'webhook', url: NEW_HOOK.url },
      events: ['run.settled'],
      enabled: true,
      name: null,
      revision: 1,
    });
    expect(JSON.stringify(created)).not.toContain(SIGNING_SECRET);
    const id = (created.result as { id: string }).id;
    for (const [method, params] of [
      ['bureau.hooks.get', { hookId: id }],
      ['bureau.hooks.list', {}],
      ['bureau.hooks.deliveries', { hookId: id }],
    ] as const) {
      expect(
        JSON.stringify(await call(opened, method, params, 'alice-observer-key')),
      ).not.toContain(SIGNING_SECRET);
    }
  });

  it('requires bureau.events:observe-all to create, and an owner to own', async () => {
    const { opened } = await open();
    const forbidden = await call(opened, 'bureau.hooks.create', NEW_HOOK, 'alice-key');
    expect(forbidden.error?.data).toMatchObject({
      reason: 'missing scope bureau.events:observe-all',
    });
    // A write scope alone is not enough, and neither names an owner a credential lacks.
    const writer = await call(opened, 'bureau.hooks.create', NEW_HOOK, 'hooks-writer-key');
    expect(writer.error?.data).toMatchObject({ reason: 'missing scope bureau.events:observe-all' });
  });

  it('shows a hook and its deliveries only to its owner, and answers anyone else as for a missing one', async () => {
    const { opened } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    await call(opened, 'bureau.hooks.test', { hookId: hook.id }, 'alice-key');

    for (const [method, params] of [
      ['bureau.hooks.get', { hookId: hook.id }],
      ['bureau.hooks.update', { hookId: hook.id, enabled: false }],
      ['bureau.hooks.delete', { hookId: hook.id }],
      ['bureau.hooks.test', { hookId: hook.id }],
      ['bureau.hooks.deliveries', { hookId: hook.id }],
    ] as const) {
      const other = await call(opened, method, params, 'bob-key');
      const missing = await call(opened, method, { ...params, hookId: 'no-such-hook' }, 'bob-key');
      expect([method, other.error?.data?.['resource'], other.error?.code]).toEqual([
        method,
        'hook',
        missing.error?.code,
      ]);
      // Identical but for the identifier the caller itself named.
      expect(JSON.stringify(other.error).replaceAll(hook.id, 'ID')).toBe(
        JSON.stringify(missing.error).replaceAll('no-such-hook', 'ID'),
      );
    }

    const bobs = await call(opened, 'bureau.hooks.list', {}, 'bob-key');
    expect(bobs.result).toEqual({ hooks: [] });
    const alices = await call(opened, 'bureau.hooks.list', {}, 'alice-key');
    expect((alices.result as { hooks: unknown[] }).hooks).toHaveLength(1);
    // Still there, untouched.
    const still = await call(opened, 'bureau.hooks.get', { hookId: hook.id }, 'alice-key');
    expect(still.result).toMatchObject({ id: hook.id, enabled: true });
  });

  it('grants the read and write scopes across owners, neither implying the other', async () => {
    const { opened } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    const id = { hookId: hook.id };
    const disable = { hookId: hook.id, enabled: false };

    expect(await resultOf(opened, 'bureau.hooks.get', id, 'hooks-reader-key')).toMatchObject({
      id: hook.id,
    });
    expect(await resultOf(opened, 'bureau.hooks.list', {}, 'hooks-reader-key')).toMatchObject({
      hooks: [{ id: hook.id }],
    });
    expect(
      await errorOf(opened, 'bureau.hooks.deliveries', id, 'hooks-reader-key'),
    ).toBeUndefined();
    const readerUpdate = await errorOf(opened, 'bureau.hooks.update', disable, 'hooks-reader-key');
    expect(readerUpdate?.data).toMatchObject({ resource: 'hook' });

    const writerGet = await errorOf(opened, 'bureau.hooks.get', id, 'hooks-writer-key');
    expect(writerGet?.data).toMatchObject({ resource: 'hook' });
    expect(await resultOf(opened, 'bureau.hooks.list', {}, 'hooks-writer-key')).toEqual({
      hooks: [],
    });
    expect(
      await resultOf(opened, 'bureau.hooks.update', disable, 'hooks-writer-key'),
    ).toMatchObject({
      enabled: false,
      owner: 'api-key:alice',
    });
    expect(await errorOf(opened, 'bureau.hooks.test', id, 'hooks-writer-key')).toBeUndefined();
    expect(await resultOf(opened, 'bureau.hooks.delete', id, 'hooks-writer-key')).toEqual({
      hookId: hook.id,
      deleted: true,
    });
  });

  it('needs observe-all to change the events of a hook, and no scope to change anything else of one’s own', async () => {
    const { opened } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    const rename = await call(
      opened,
      'bureau.hooks.update',
      { hookId: hook.id, name: 'mine' },
      'alice-key',
    );
    expect(rename.result).toMatchObject({ name: 'mine' });
    const events = await call(
      opened,
      'bureau.hooks.update',
      { hookId: hook.id, events: ['run.registered'] },
      'alice-key',
    );
    expect(events.error?.data).toMatchObject({ reason: 'missing scope bureau.events:observe-all' });
  });

  it('needs observe-all of the caller to re-point, widen or re-enable a hook, whoever owns it', async () => {
    const { opened } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    const missing = { reason: 'missing scope bureau.events:observe-all' };
    const attacker = { hookId: hook.id, url: 'https://attacker.example/steal' };

    // A key that may write any owner's hook, but may not observe the whole Bureau's events.
    const writer = await call(opened, 'bureau.hooks.update', attacker, 'hooks-writer-key');
    expect(writer.error?.data).toMatchObject(missing);
    // The owner's own key, without the scope, is held to the same rule.
    const owner = await call(opened, 'bureau.hooks.update', attacker, 'alice-key');
    expect(owner.error?.data).toMatchObject(missing);
    const widened = await call(
      opened,
      'bureau.hooks.update',
      { hookId: hook.id, events: ['run.registered'] },
      'hooks-writer-key',
    );
    expect(widened.error?.data).toMatchObject(missing);
    expect(
      await resultOf(opened, 'bureau.hooks.get', { hookId: hook.id }, 'alice-key'),
    ).toMatchObject({
      action: { type: 'webhook', url: NEW_HOOK.url },
      events: ['run.settled'],
      revision: 1,
    });

    // Disabling narrows reach, so it needs no scope; enabling it again restores it, so it does.
    const disabled = { hookId: hook.id, enabled: false };
    expect(
      await resultOf(opened, 'bureau.hooks.update', disabled, 'hooks-writer-key'),
    ).toMatchObject({
      enabled: false,
    });
    const enable = { hookId: hook.id, enabled: true };
    const enableAsWriter = await call(opened, 'bureau.hooks.update', enable, 'hooks-writer-key');
    expect(enableAsWriter.error?.data).toMatchObject(missing);
    expect(
      await resultOf(opened, 'bureau.hooks.update', enable, 'alice-observer-key'),
    ).toMatchObject({
      enabled: true,
    });

    // The scope is what is needed: a caller holding it may re-point the hook.
    expect(await resultOf(opened, 'bureau.hooks.update', attacker, 'operator-key')).toMatchObject({
      action: { type: 'webhook', url: attacker.url },
    });
  });

  it('lets a caller without observe-all test a hook, which sends a fixed message and never an event', async () => {
    const { opened, receiver } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    const tested = await resultOf(
      opened,
      'bureau.hooks.test',
      { hookId: hook.id },
      'hooks-writer-key',
    );
    expect(tested).toMatchObject({ kind: 'hook.test', test: true, status: 'delivered' });
    expect(receiver.calls).toHaveLength(1);
    expect(JSON.parse(receiver.calls[0]!.body)).toMatchObject({
      kind: 'hook.test',
      payload: { message: expect.any(String) },
    });
  });

  it('audits the caller as the actor of a change, not the hook’s owner', async () => {
    const { opened } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    await call(
      opened,
      'bureau.hooks.update',
      { hookId: hook.id, name: 'by-writer' },
      'hooks-writer-key',
    );
    await call(opened, 'bureau.hooks.test', { hookId: hook.id }, 'hooks-writer-key');
    await call(opened, 'bureau.hooks.delete', { hookId: hook.id }, 'hooks-writer-key');

    const entries = async () => {
      const queried = await opened.bureau.audit.query({ runId: `hook:${hook.id}` });
      return queried.records;
    };
    await waitForCondition(async () => {
      const found = await entries();
      return found.length >= 4;
    }, 'the audit entries never arrived');
    const found = await entries();
    const byType = Object.fromEntries(found.map((entry) => [entry.type, entry]));

    // The creator is the owner, so for a creation they are the same.
    expect(byType['hook.created']?.principal).toBe('api-key:alice');
    for (const type of ['hook.updated', 'hook.tested', 'hook.deleted']) {
      expect([type, byType[type]?.principal]).toEqual([type, 'api-key:hooks-writer']);
      expect(byType[type]?.detail).toMatchObject({ hookId: hook.id });
    }
  });

  it('sends a test delivery and answers its record, with the response excerpt', async () => {
    const { opened, receiver } = await open();
    const hook = await createAs(opened, 'alice-observer-key');
    const tested = await call(opened, 'bureau.hooks.test', { hookId: hook.id }, 'alice-key');

    expect(tested.error).toBeUndefined();
    expect(tested.result).toMatchObject({
      hookId: hook.id,
      owner: 'api-key:alice',
      kind: 'hook.test',
      test: true,
      status: 'delivered',
      attempts: [{ number: 1, outcome: 'response', status: 200, responseExcerpt: 'pong' }],
    });
    expect(receiver.calls).toHaveLength(1);
    const listed = await call(opened, 'bureau.hooks.deliveries', { hookId: hook.id }, 'alice-key');
    expect(listed.result).toMatchObject({
      deliveries: [{ id: (tested.result as { id: string }).id }],
    });
  });

  it('answers InvalidParams for an unacceptable URL, event, or secret, and StaleRevision for a stale update', async () => {
    const { opened } = await open();
    const badUrl = await call(
      opened,
      'bureau.hooks.create',
      { ...NEW_HOOK, url: 'http://169.254.169.254/' },
      'alice-observer-key',
    );
    expect(badUrl.error?.data).toMatchObject({ issues: [{ path: ['url'] }] });
    const badEvent = await call(
      opened,
      'bureau.hooks.create',
      { ...NEW_HOOK, events: ['hook.test'] },
      'alice-observer-key',
    );
    expect(badEvent.error?.code).toBe(-32602);
    const shortSecret = await call(
      opened,
      'bureau.hooks.create',
      { ...NEW_HOOK, signingSecret: 'short' },
      'alice-observer-key',
    );
    expect(shortSecret.error?.code).toBe(-32602);

    const hook = await createAs(opened, 'alice-observer-key');
    await call(opened, 'bureau.hooks.update', { hookId: hook.id, enabled: false }, 'alice-key');
    const stale = await call(
      opened,
      'bureau.hooks.update',
      { hookId: hook.id, name: 'renamed', expectedRevision: 1 },
      'alice-key',
    );
    expect(stale.error?.data).toMatchObject({ currentRevision: 2 });
  });

  it('refuses a secret write with Forbidden and reason deployment when the host locks them', async () => {
    const held = new Map<string, Awaited<ReturnType<HookSecretStore['get']>>>();
    const secrets: HookSecretStore = {
      writeLock: () => 'deployment',
      get: async (id) => held.get(id),
      set: async (id, encrypted) => void held.set(id, encrypted),
      delete: async (id) => void held.delete(id),
    };
    const { opened } = await open({ secrets });

    const refused = await call(opened, 'bureau.hooks.create', NEW_HOOK, 'alice-observer-key');

    expect(refused.error?.data).toMatchObject({ reason: 'deployment' });
    expect(refused.error?.data?.httpStatus).toBe(403);
    expect(held.size).toBe(0);
    expect(await resultOf(opened, 'bureau.hooks.list', {}, 'alice-key')).toEqual({ hooks: [] });
  });

  it('creates a notify hook for the caller, shows it as an action, and shows its delivery as work with a receipt', async () => {
    const { opened } = await open();
    const created = await call(
      opened,
      'bureau.hooks.create',
      { events: ['run.registered'], action: { type: 'notify', title: 'A run began' } },
      'alice-observer-key',
    );
    expect(created.error).toBeUndefined();
    expect(created.result).toMatchObject({
      owner: 'api-key:alice',
      action: { type: 'notify', title: 'A run began' },
    });
    expect(Object.keys(created.result!)).not.toContain('url');
    const id = (created.result as { id: string }).id;

    await opened.bureau.tasks.start('default', 'hello', { principal: 'api-key:alice' });
    let deliveries: Array<Record<string, unknown>> = [];
    await waitForCondition(async () => {
      const listed = await call(opened, 'bureau.hooks.deliveries', { hookId: id }, 'alice-key');
      deliveries = (listed.result?.['deliveries'] ?? []) as Array<Record<string, unknown>>;
      return deliveries.length === 1 && deliveries[0]!['status'] === 'delivered';
    }, 'the notify delivery never completed');

    expect(deliveries[0]).toMatchObject({
      actionType: 'notify',
      request: null,
      work: { type: 'notify', title: 'A run began', workflowId: null, skip: null },
      attempts: [{ outcome: 'completed', receipt: { notificationId: expect.any(String) } }],
    });
    const notifications = await call(opened, 'bureau.notifications.list', {}, 'alice-key');
    const listedNotifications = (notifications.result?.['notifications'] ?? []) as Array<{
      kind: string;
    }>;
    expect(listedNotifications.map((n) => n.kind)).toContain('hook');
  });

  it('shows why a start-workflow delivery started nothing as work.skip, and null where there is no skip', async () => {
    const storage = new MemoryStorage();
    const { opened } = await open({ storage });
    const created = await call(opened, 'bureau.hooks.create', NEW_HOOK, 'alice-observer-key');
    const hookId = (created.result as { id: string }).id;
    const reason = 'Skipped: session.saved can be raised by a run a hook started';
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const delivery = (id: string, skip: string | undefined): HookDeliveryRecord => ({
      version: 1,
      id,
      hookId,
      owner: 'api-key:alice',
      actionType: 'start-workflow',
      kind: 'session.saved',
      test: false,
      status: 'failed',
      work: {
        type: 'start-workflow',
        workflowId: 'digest',
        input: {},
        ...(skip === undefined ? {} : { skip }),
      },
      attempts: [],
      maxAttempts: 3,
      createdAt: id === 'delivery-skipped' ? 2 : 1,
      updatedAt: 2,
      leaseUntil: 0,
      revision: 1,
    });
    await kv.set(
      `${HOOK_DELIVERY_KEY_PREFIX}delivery-skipped`,
      JSON.stringify(delivery('delivery-skipped', reason)),
    );
    await kv.set(
      `${HOOK_DELIVERY_KEY_PREFIX}delivery-plain`,
      JSON.stringify(delivery('delivery-plain', undefined)),
    );

    const listed = await call(opened, 'bureau.hooks.deliveries', { hookId }, 'alice-key');
    expect(listed.error).toBeUndefined();
    const deliveries = listed.result!['deliveries'] as Array<{
      id: string;
      work: { skip: string | null };
    }>;
    expect(deliveries.map((d) => [d.id, d.work.skip])).toEqual([
      ['delivery-skipped', reason],
      ['delivery-plain', null],
    ]);
  });

  it('answers InvalidParams for an action that is malformed, mixed with a url, or loops, and for testing a notify hook', async () => {
    const { opened } = await open();
    const create = (params: object) =>
      call(
        opened,
        'bureau.hooks.create',
        { events: ['run.settled'], ...params },
        'alice-observer-key',
      );

    const both = await create({ ...NEW_HOOK, action: { type: 'notify' } });
    expect(both.error?.data).toMatchObject({ issues: [{ path: ['action'] }] });
    const noSecret = await create({ url: NEW_HOOK.url });
    expect(noSecret.error?.data).toMatchObject({ issues: [{ path: ['signingSecret'] }] });
    const looping = await create({
      events: ['notification.created'],
      action: { type: 'notify' },
    });
    expect(looping.error?.data).toMatchObject({ issues: [{ path: ['events'] }] });
    const unknownType = await create({ action: { type: 'teleport' } });
    expect(unknownType.error?.code).toBe(-32602);

    const hook = await create({ action: { type: 'notify' } });
    expect(hook.error).toBeUndefined();
    const id = (hook.result as { id: string }).id;
    const tested = await call(opened, 'bureau.hooks.test', { hookId: id }, 'alice-key');
    expect(tested.error?.data).toMatchObject({ issues: [{ path: ['action'] }] });
    const changed = await call(
      opened,
      'bureau.hooks.update',
      { hookId: id, events: ['notification.created'] },
      'alice-observer-key',
    );
    expect(changed.error?.data).toMatchObject({ issues: [{ path: ['events'] }] });
    const retyped = await call(
      opened,
      'bureau.hooks.update',
      { hookId: id, action: { type: 'start-workflow', workflowId: 'x' } },
      'alice-observer-key',
    );
    expect(retyped.error?.code).toBeDefined();
  });

  it('answers Forbidden to a start-workflow hook from a caller who cannot start workflows, and from an owner the Bureau will not run it as', async () => {
    const { opened } = await open();
    const action = { type: 'start-workflow', workflowId: 'digest' };
    // Alice may observe the Bureau but may not start workflows.
    const caller = await call(
      opened,
      'bureau.hooks.create',
      { events: ['run.settled'], action },
      'alice-observer-key',
    );
    expect(caller.error?.data).toMatchObject({ reason: 'workflow authority' });
    // The operator may start them, but in v1 only the deployment’s owner of record owns such a hook.
    const operator = await call(
      opened,
      'bureau.hooks.create',
      { events: ['run.settled'], action },
      'operator-key',
    );
    expect(operator.error?.data).toMatchObject({ reason: 'workflow authority' });
    expect(await resultOf(opened, 'bureau.hooks.list', {}, 'operator-key')).toEqual({ hooks: [] });
  });

  it('answers UnsupportedCapability on a Bureau without hooks', async () => {
    const { opened } = await open({ withoutHooks: true });
    const response = await call(opened, 'bureau.hooks.list', {}, 'alice-key');
    expect(response.error?.data).toMatchObject({ capability: 'hooks' });
  });

  it('answers UnsupportedCapability, and writes nothing, when the Bureau has no key to seal a secret', async () => {
    const receiver = createReceiver();
    const opened = await openBureau({
      bureauOptions: {
        hooks: {},
        webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
      },
    });
    cleanups.push(() => opened.dispose());
    const response = await call(opened, 'bureau.hooks.create', NEW_HOOK, 'alice-observer-key');
    expect(response.error?.data).toMatchObject({ capability: 'encryption' });
    expect(await resultOf(opened, 'bureau.hooks.list', {}, 'alice-key')).toEqual({ hooks: [] });
  });
});
