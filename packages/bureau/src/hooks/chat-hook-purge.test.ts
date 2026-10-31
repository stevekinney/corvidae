/**
 * COR-1953 — which hook deliveries a chat delete takes: those of events about the chat's runs or
 * its deleted incarnation, pending ones included, and no others.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { isDeliveryOfChat, purgeChatHookDeliveries } from './chat-hook-purge.ts';
import { createHookStore } from './hook-store.ts';
import type { HookDeliveryRecord } from './hook-types.ts';

const CHAT = { sessionId: 'session-1', incarnation: 'incarnation-1' };
const RUNS = new Set(['run-1', 'run-2']);

let counter = 0;
function delivery(
  shape: Partial<HookDeliveryRecord> & Pick<HookDeliveryRecord, 'status'>,
): HookDeliveryRecord {
  counter += 1;
  return {
    version: 1,
    id: `delivery-${counter}`,
    hookId: 'hook-1',
    owner: 'api-key:alice',
    actionType: 'webhook',
    kind: 'run.settled',
    test: false,
    attempts: [],
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    leaseUntil: 0,
    revision: 0,
    ...shape,
  };
}

const webhook = (payload: unknown, status: HookDeliveryRecord['status'] = 'delivered') =>
  delivery({
    status,
    request: {
      url: 'https://receiver.example/hook',
      headers: {},
      body: JSON.stringify({ id: 'x', kind: 'k', payload }),
    },
  });

const workflow = (input: unknown) =>
  delivery({
    status: 'delivered',
    actionType: 'start-workflow',
    work: { type: 'start-workflow', workflowId: 'wf', input },
  });

const pluginAction = (payload: unknown) =>
  delivery({
    status: 'delivered',
    actionType: 'plugin',
    work: {
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      event: { kind: 'run.settled', bureauId: 'bureau-1', emittedAtMs: 1, payload },
    },
  });

describe('which deliveries are a chat’s', () => {
  it.each([
    ['a webhook whose payload names one of the runs', webhook({ runId: 'run-2' })],
    [
      'a webhook whose payload names a goal run, a task or a blocking run',
      webhook({ blockingRunId: 'run-1' }),
    ],
    ['a webhook whose payload lists a run', webhook({ runIds: ['other', 'run-1'] })],
    [
      'a webhook about the deleted incarnation',
      webhook({ sessionId: 'session-1', incarnation: 'incarnation-1' }),
    ],
    ['a pending webhook', webhook({ runId: 'run-1' }, 'pending')],
    ['a workflow started with the payload', workflow({ runId: 'run-1' })],
    ['a plugin action that was given the event', pluginAction({ runId: 'run-1' })],
    [
      'a workflow started with the event',
      workflow({ kind: 'run.settled', payload: { runId: 'run-1' } }),
    ],
  ])('takes %s', (_name, record) => {
    expect(isDeliveryOfChat(record, CHAT, RUNS)).toBe(true);
  });

  it.each([
    ['a webhook about another run', webhook({ runId: 'run-3' })],
    [
      'a webhook about a recreated chat of the same id',
      webhook({ sessionId: 'session-1', incarnation: 'incarnation-2' }),
    ],
    [
      'a webhook whose body is not JSON',
      delivery({
        status: 'delivered',
        request: { url: 'https://receiver.example/hook', headers: {}, body: 'run-1' },
      }),
    ],
    ['a plugin action given an event about another run', pluginAction({ runId: 'run-3' })],
    [
      'a notification, which holds no payload',
      delivery({
        status: 'delivered',
        actionType: 'notify',
        work: { type: 'notify', title: 'run-1', body: 'run-1' },
      }),
    ],
  ])('leaves %s', (_name, record) => {
    expect(isDeliveryOfChat(record, CHAT, RUNS)).toBe(false);
  });
});

describe('purgeChatHookDeliveries', () => {
  it('removes the chat’s deliveries with their pending index keys, and nothing else', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const store = createHookStore(kv);
    const doomed = webhook({ runId: 'run-1' }, 'pending');
    const kept = webhook({ runId: 'run-9' }, 'pending');
    await store.createDelivery(doomed);
    await store.createDelivery(kept);

    expect(await purgeChatHookDeliveries(store, CHAT, RUNS)).toBe(1);

    expect(await store.getDelivery(doomed.id)).toBeUndefined();
    expect(await store.listPendingDeliveryIds()).toEqual([kept.id]);
    expect(await purgeChatHookDeliveries(store, CHAT, RUNS)).toBe(0);
  });
});
