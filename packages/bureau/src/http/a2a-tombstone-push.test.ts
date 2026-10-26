/**
 * Push notifications on a tombstone mount (COR-1669, part 2b-2): a withdrawn agent that still has
 * a task keeps `Get`, `List`, and `Delete` of that task's push configurations, `Create` for a
 * task that has not ended, and delivery to the configurations that exist, until the task ends.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, Outbox } from '@lostgradient/weft';
import {
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  pushNotificationResolvers,
  startPushDelivery,
} from '@lostgradient/weft/a2a';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSqliteStorageFixture } from '../test/storage-fixtures';
import {
  type FileBureauHarness,
  startFileBureau,
} from '../testing/agent-file-bureau.test-support.ts';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support.ts';
import { eventually, type Json, Receiver, SIGNING_SECRET } from './a2a-push.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { authentication } from './management/management-fixtures.test-support.ts';

/** Parks a task whose first message says `park` on a human wait once; answers anything else. */
const parksOnRequest: GenerateFunction = async ({ conversation }) => {
  const messages = conversation.getMessages();
  const first = JSON.stringify(messages.find((message) => message.role === 'user')?.content);
  const answered = messages.some((message) => message.role === 'tool-result');
  return first.includes('park') && !answered
    ? {
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Which?' },
          },
        ],
      }
    : { content: 'done', toolCalls: [] };
};

type Served = {
  readonly harness: FileBureauHarness;
  readonly receiver: Receiver;
  readonly call: (method: string, params: Json, key?: string) => Promise<Json>;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function serve(): Promise<Served> {
  const runtime = createDefaultRuntimeServices();
  const fixture = createSqliteStorageFixture({ runtime });
  const storage = new MemoryStorage();
  const receiver = new Receiver();
  const pushStore = createWeftPushNotificationStore({ storage, namespace: 'bureau-push' });
  const adapter = createHttpDeliveryAdapter({
    ...pushNotificationResolvers(pushStore),
    signingSecrets: [SIGNING_SECRET],
    egressPolicy: createEgressPolicy({
      allowInsecureHttp: true,
      allowlist: [receiver.host],
      resolveHost: null,
    }),
  });
  const outbox = new Outbox({ storage, namespace: 'bureau-push', ownerId: 'push', adapter });
  const sender = createOutboxPushNotificationSender({ outbox, pushStore });
  const harness = await startFileBureau({
    overrides: {
      id: 'tombstone-push-bureau',
      humanInput: true,
      models: { generate: () => parksOnRequest },
      storage: fixture.configuration,
    },
  });
  await harness.put(
    'writer.md',
    agentFileText({ name: 'Writer', model: KNOWN_MODEL, published: 'true' }, 'Write.\n'),
  );
  await harness.bureau.agents.refresh();
  const handler = createBureauHandler(harness.bureau, {
    authentication,
    publicUrl: 'http://localhost',
    pushNotifications: { sender, outbox },
  });
  const delivery = new AbortController();
  void startPushDelivery({ outbox, signal: delivery.signal, intervalMs: 10 });
  cleanups.push(async () => {
    delivery.abort();
    receiver.close();
    await harness.dispose();
    await fixture.dispose();
    outbox.dispose();
    storage[Symbol.dispose]();
  });
  return {
    harness,
    receiver,
    async call(method, params, key = 'alice-key') {
      const response = await handler(
        new Request('http://localhost/a2a/writer', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-API-Key': key },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      );
      return response.json();
    },
  };
}

let counter = 0;
const message = (text: string, extra: Json = {}): Json => {
  counter += 1;
  return { messageId: `tp-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
};

const webhook = (served: Served, extra: Json = {}): Json => ({
  url: served.receiver.url(),
  token: 'token-1',
  authentication: { scheme: 'Bearer', credentials: 'credential-secret' },
  ...extra,
});

async function withdraw(served: Served): Promise<void> {
  const { bureau } = served.harness;
  const hash = bureau.agents.list().find((agent) => agent.id === 'writer')?.definitionHash;
  if (hash === undefined) throw new Error('expected the writer’s file');
  await bureau.agents.withdraw('writer', { expectedHash: hash });
  await bureau.agents.refresh();
  expect(bureau.agents.list().some((agent) => agent.id === 'writer' && !agent.published)).toBe(
    true,
  );
}

async function parked(served: Served): Promise<string> {
  const sent = await served.call('SendMessage', { message: message('park here') });
  expect(sent.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  return sent.result.task.id;
}

describe('push configurations on a withdrawn agent’s tombstone mount', () => {
  it('serves Create, Get, List, and Delete for a task that has not ended', async () => {
    const served = await serve();
    const taskId = await parked(served);
    await served.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'before',
      ...webhook(served),
    });
    await withdraw(served);

    const created = await served.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'after',
      ...webhook(served),
    });
    expect(created.result.id).toBe('after');
    const got = await served.call('GetTaskPushNotificationConfig', { taskId, id: 'before' });
    expect(got.result.authentication.credentials).toBe('[REDACTED]');
    const listed = await served.call('ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs.map((config: Json) => config.id)).toEqual(['before', 'after']);
    const deleted = await served.call('DeleteTaskPushNotificationConfig', { taskId, id: 'after' });
    expect(deleted.error).toBeUndefined();
    const gone = await served.call('GetTaskPushNotificationConfig', { taskId, id: 'after' });
    expect(gone.error.code).toBe(-32001);
  });

  it('keeps delivering to an existing configuration until the task ends', async () => {
    const served = await serve();
    const taskId = await parked(served);
    await served.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'hook',
      ...webhook(served),
    });
    await withdraw(served);

    await served.call('SendMessage', {
      message: message('blue', { taskId, metadata: { signalName: 'human-response' } }),
      configuration: { returnImmediately: true },
    });

    await eventually(() => served.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
  });

  it('refuses Create for a task that has ended, and still reads its configurations', async () => {
    const served = await serve();
    const taskId = await parked(served);
    await served.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'hook',
      ...webhook(served),
    });
    await withdraw(served);
    await served.call('CancelTask', { id: taskId });
    await eventually(async () => {
      const task = await served.call('GetTask', { id: taskId });
      return task.result.status.state === 'TASK_STATE_CANCELED';
    });

    const created = await served.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'late',
      ...webhook(served),
    });
    expect(created.error.code).toBe(-32004);
    const listed = await served.call('ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs.map((config: Json) => config.id)).toEqual(['hook']);
  });

  it('scopes every operation to the task’s owner', async () => {
    const served = await serve();
    const taskId = await parked(served);
    await withdraw(served);

    for (const [method, params] of [
      ['CreateTaskPushNotificationConfig', { taskId, ...webhook(served) }],
      ['GetTaskPushNotificationConfig', { taskId, id: 'x' }],
      ['ListTaskPushNotificationConfigs', { taskId }],
      ['DeleteTaskPushNotificationConfig', { taskId, id: 'x' }],
    ] as const) {
      const reply = await served.call(method, params, 'bob-key');
      expect(reply.error.code).toBe(-32001);
    }
  });

  it('replays a configuration created while the task was live, once the task has ended', async () => {
    const served = await serve();
    const taskId = await parked(served);
    const params = { taskId, id: 'hook', ...webhook(served) };
    const first = await served.call('CreateTaskPushNotificationConfig', params);
    expect(first.result.id).toBe('hook');
    await withdraw(served);
    await served.call('CancelTask', { id: taskId });
    await eventually(async () => {
      const task = await served.call('GetTask', { id: taskId });
      return task.result.status.state === 'TASK_STATE_CANCELED';
    });

    const retried = await served.call('CreateTaskPushNotificationConfig', params);
    expect(retried.error).toBeUndefined();
    expect(retried.result.id).toBe('hook');
    const listed = await served.call('ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs).toHaveLength(1);

    const other = await served.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'other',
      ...webhook(served),
    });
    expect(other.error.code).toBe(-32004);
  });
});
