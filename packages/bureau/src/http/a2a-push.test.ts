/**
 * A2A push notifications over Bureau (COR-1543): the card declares push only where both an outbox
 * and the durable event history are composed, a configuration is created, read, listed, and
 * deleted through the standard operations or embedded in a send, and the projector delivers the
 * task's durable events to its webhook once, in order.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { createA2APushCheckpoints } from './a2a-push-checkpoint.ts';

import {
  call,
  eventually,
  type Json,
  message,
  openPushBureau,
  type PushFixture,
  webhook,
} from './a2a-push.test-support.ts';

const open: PushFixture[] = [];
afterEach(async () => {
  for (const fixture of open.splice(0)) await fixture.dispose();
});

async function fixtureOf(
  generate: GenerateFunction,
  options: Parameters<typeof openPushBureau>[1] = {},
): Promise<PushFixture> {
  const fixture = await openPushBureau(generate, options);
  open.push(fixture);
  return fixture;
}

const answering =
  (content: string): GenerateFunction =>
  async () => ({ content, toolCalls: [] });

async function card(fixture: PushFixture): Promise<Json> {
  const response = await fixture.opened.handler(
    new Request('http://localhost/a2a/asker/.well-known/agent-card.json'),
  );
  return response.json();
}

/** Sends a message without waiting for the task to settle and resolves its identifier. */
async function startTask(fixture: PushFixture, configuration: Json = {}): Promise<string> {
  const reply = await call(fixture, 'SendMessage', {
    message: message('go'),
    configuration: { returnImmediately: true, ...configuration },
  });
  return reply.result.task.id;
}

describe('the card', () => {
  it('declares push where the outbox and the durable history are both composed', async () => {
    const fixture = await fixtureOf(answering('done'));

    const body = await card(fixture);
    expect(body.capabilities.pushNotifications).toBe(true);
  });

  it('declares no push with an outbox but no durable history, and answers -32003', async () => {
    const fixture = await fixtureOf(answering('done'), { durableHistory: false });

    const body = await card(fixture);
    expect(body.capabilities.pushNotifications).toBeFalsy();
    const created = await call(fixture, 'CreateTaskPushNotificationConfig', {
      taskId: 'no-such-task',
      ...webhook(fixture),
    });
    expect(created.error.code).toBe(-32003);
  });

  it('declares no push without an outbox, and every push operation answers -32003', async () => {
    const fixture = await fixtureOf(answering('done'), { push: false });

    const body = await card(fixture);
    expect(body.capabilities.pushNotifications).toBeFalsy();
    for (const [method, params] of [
      ['CreateTaskPushNotificationConfig', { taskId: 't', ...webhook(fixture) }],
      ['GetTaskPushNotificationConfig', { taskId: 't', id: 'c' }],
      ['ListTaskPushNotificationConfigs', { taskId: 't' }],
      ['DeleteTaskPushNotificationConfig', { taskId: 't', id: 'c' }],
    ] as const) {
      const reply = await call(fixture, method, params);
      expect(reply.error.code).toBe(-32003);
    }
    // A send that embeds a configuration is refused before a task is created.
    const sent = await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: { taskPushNotificationConfig: webhook(fixture) },
    });
    expect(sent.error.code).toBe(-32003);
    const listed = await call(fixture, 'ListTasks', {});
    expect(listed.result.tasks).toEqual([]);
  });

  it('keeps extendedAgentCard false and every extension optional', async () => {
    const fixture = await fixtureOf(answering('done'));
    const body = await card(fixture);

    expect(body.capabilities.streaming).toBe(true);
    expect(body.capabilities.extendedAgentCard).toBeFalsy();
    expect(body.capabilities.extensions.every((entry: Json) => !entry.required)).toBe(true);
  });
});

describe('the sweep interval', () => {
  it('accepts a positive integer and refuses anything else at construction', async () => {
    await fixtureOf(answering('done'), { sweepIntervalMs: 60_000 });
    for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      const failure = await throwingRejectionOf(
        openPushBureau(answering('done'), { sweepIntervalMs: bad }),
      );
      expect(failure).toThrow(/sweepIntervalMs/);
    }
  });
});

describe('push configuration operations', () => {
  it('creates, gets, lists with redacted credentials, and deletes a configuration', async () => {
    const fixture = await fixtureOf(answering('done'));
    const taskId = await startTask(fixture);

    const created = await call(fixture, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'hook-1',
      ...webhook(fixture),
    });
    expect(created.result.id).toBe('hook-1');

    const got = await call(fixture, 'GetTaskPushNotificationConfig', { taskId, id: 'hook-1' });
    expect(got.result.url).toBe(fixture.receiver.url());
    expect(got.result.authentication.credentials).toBe('[REDACTED]');

    const listed = await call(fixture, 'ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs.map((config: Json) => config.id)).toEqual(['hook-1']);
    expect(listed.result.configs[0].authentication.credentials).toBe('[REDACTED]');
    expect(listed.result.nextPageToken ?? '').toBe('');

    const deleted = await call(fixture, 'DeleteTaskPushNotificationConfig', {
      taskId,
      id: 'hook-1',
    });
    expect(deleted.error).toBeUndefined();
    const after = await call(fixture, 'GetTaskPushNotificationConfig', { taskId, id: 'hook-1' });
    expect(after.error.code).toBe(-32001);
  });

  it('pages the list by creation order and binds the token to the task', async () => {
    const fixture = await fixtureOf(answering('done'));
    const taskId = await startTask(fixture);
    const other = await startTask(fixture);
    for (const id of ['a', 'b', 'c']) {
      await call(fixture, 'CreateTaskPushNotificationConfig', { taskId, id, ...webhook(fixture) });
    }

    const first = await call(fixture, 'ListTaskPushNotificationConfigs', { taskId, pageSize: 2 });
    expect(first.result.configs.map((config: Json) => config.id)).toEqual(['a', 'b']);
    expect(first.result.nextPageToken).not.toBe('');
    const second = await call(fixture, 'ListTaskPushNotificationConfigs', {
      taskId,
      pageSize: 2,
      pageToken: first.result.nextPageToken,
    });
    expect(second.result.configs.map((config: Json) => config.id)).toEqual(['c']);
    expect(second.result.nextPageToken ?? '').toBe('');

    const replayed = await call(fixture, 'ListTaskPushNotificationConfigs', {
      taskId: other,
      pageSize: 2,
      pageToken: first.result.nextPageToken,
    });
    expect(replayed.error.code).toBe(-32602);
  });

  it("serves one caller's task to no other caller", async () => {
    const fixture = await fixtureOf(answering('done'));
    const taskId = await startTask(fixture);

    const created = await call(
      fixture,
      'CreateTaskPushNotificationConfig',
      { taskId, ...webhook(fixture) },
      'bob-key',
    );
    expect(created.error.code).toBe(-32001);
  });
});

describe('delivery', () => {
  it('delivers a configuration embedded in the first message, from the first event', async () => {
    const fixture = await fixtureOf(answering('done'));
    fixture.startDelivery();

    const task = await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: { returnImmediately: true, taskPushNotificationConfig: webhook(fixture) },
    });

    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
    const kinds = fixture.receiver.kinds();
    expect(task.result.task.id).toBeTruthy();
    expect(kinds.at(-1)).toBe('status:TASK_STATE_COMPLETED');
    expect(kinds.filter((kind) => kind === 'status:TASK_STATE_COMPLETED')).toHaveLength(1);
    expect(fixture.receiver.requests[0]?.headers['x-a2a-notification-token']).toBe('token-1');
  });

  it('leaves one configuration after an exact retry of the send', async () => {
    const fixture = await fixtureOf(answering('done'));
    const params = {
      message: message('go'),
      configuration: { returnImmediately: true, taskPushNotificationConfig: webhook(fixture) },
    };

    const first = await call(fixture, 'SendMessage', params);
    const retry = await call(fixture, 'SendMessage', params);

    const taskId = first.result.task.id;
    expect(retry.result.task.id).toBe(taskId);
    const listed = await call(fixture, 'ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs).toHaveLength(1);
  });

  it('delivers nothing from before a configuration was created', async () => {
    const fixture = await fixtureOf(answering('done'));
    const taskId = await startTask(fixture);
    await eventually(async () => {
      const task = await call(fixture, 'GetTask', { id: taskId });
      return task.result.status.state === 'TASK_STATE_COMPLETED';
    });
    await call(fixture, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'late',
      ...webhook(fixture),
    });
    fixture.startDelivery();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fixture.receiver.requests).toEqual([]);
  });

  it('delivers the next event of a continued task to a configuration sent with the continuation', async () => {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls += 1;
      return calls === 1
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
    const fixture = await fixtureOf(generate, { humanInput: true });
    fixture.startDelivery();
    const taskId = await startTask(fixture);
    await eventually(async () => {
      const task = await call(fixture, 'GetTask', { id: taskId });
      return task.result.status.state === 'TASK_STATE_INPUT_REQUIRED';
    });

    await call(fixture, 'SendMessage', {
      message: message('red', { taskId, metadata: { signalName: 'human-response' } }),
      configuration: { returnImmediately: true, taskPushNotificationConfig: webhook(fixture) },
    });

    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
    // Nothing the task did before the continuation reached the new webhook.
    expect(fixture.receiver.kinds()).not.toContain('status:TASK_STATE_INPUT_REQUIRED');
  });

  it('refuses a continuation that names a deleted or different configuration before it takes effect', async () => {
    const generate: GenerateFunction = async () => ({
      content: '',
      toolCalls: [
        {
          id: 'wait-1',
          name: 'requestHumanInput',
          arguments: { signalName: 'human-response', prompt: 'Which?' },
        },
      ],
    });
    const fixture = await fixtureOf(generate, { humanInput: true });
    const taskId = await startTask(fixture);
    await eventually(async () => {
      const task = await call(fixture, 'GetTask', { id: taskId });
      return task.result.status.state === 'TASK_STATE_INPUT_REQUIRED';
    });
    await call(fixture, 'CreateTaskPushNotificationConfig', {
      taskId,
      ...webhook(fixture, { id: 'hook-1' }),
    });

    const different = await call(fixture, 'SendMessage', {
      message: message('red', { taskId, metadata: { signalName: 'human-response' } }),
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: { ...webhook(fixture, { id: 'hook-1' }), token: 'other' },
      },
    });
    expect(different.error.code).toBe(-32602);

    await call(fixture, 'DeleteTaskPushNotificationConfig', { taskId, id: 'hook-1' });
    const deleted = await call(fixture, 'SendMessage', {
      message: message('red', { taskId, metadata: { signalName: 'human-response' } }),
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: webhook(fixture, { id: 'hook-1' }),
      },
    });
    expect(deleted.error.code).toBe(-32602);

    // Neither refused send answered the wait.
    const task = await call(fixture, 'GetTask', { id: taskId });
    expect(task.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('keeps the winner of two concurrent creates of one id with different webhooks pumped', async () => {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls += 1;
      return calls === 1
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
    const fixture = await fixtureOf(generate, { humanInput: true });
    fixture.startDelivery();
    const taskId = await startTask(fixture);
    await eventually(async () => {
      const task = await call(fixture, 'GetTask', { id: taskId });
      return task.result.status.state === 'TASK_STATE_INPUT_REQUIRED';
    });

    const results = await Promise.all([
      call(fixture, 'CreateTaskPushNotificationConfig', {
        taskId,
        ...webhook(fixture, { id: 'same', token: 'one' }),
      }),
      call(fixture, 'CreateTaskPushNotificationConfig', {
        taskId,
        ...webhook(fixture, { id: 'same', token: 'two' }),
      }),
    ]);
    expect(results.filter((result) => result.error === undefined)).toHaveLength(1);

    // The winner's checkpoint survived the loser's cleanup: it still receives what follows.
    await call(fixture, 'SendMessage', {
      message: message('red', { taskId, metadata: { signalName: 'human-response' } }),
      configuration: { returnImmediately: true },
    });
    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
  });

  it('installs the inline configuration of a new task whose deadline had passed', async () => {
    const fixture = await fixtureOf(answering('done'));
    const late = await call(fixture, 'SendMessage', {
      message: message('too late', {
        metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' } },
      }),
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: webhook(fixture, { id: 'hook-1' }),
      },
    });
    expect(late.error).toBeUndefined();

    const listed = await call(fixture, 'ListTaskPushNotificationConfigs', {
      taskId: late.result.task.id,
    });
    expect(listed.result.configs.map((config: Json) => config.id)).toEqual(['hook-1']);
  });

  it('holds the next event until the previous one is terminal', async () => {
    const fixture = await fixtureOf(answering('done'));
    fixture.receiver.held = [];
    fixture.startDelivery();

    await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: { returnImmediately: true, taskPushNotificationConfig: webhook(fixture) },
    });
    await eventually(() => fixture.receiver.requests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The first delivery is still open, so the second has not been enqueued.
    expect(fixture.receiver.requests).toHaveLength(1);

    const held = fixture.receiver.held;
    fixture.receiver.held = undefined;
    for (const release of held ?? []) release();
    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
  });

  it('returns from Delete within the adapter’s timeout while a receiver holds the request, and sends nothing after', async () => {
    const fixture = await fixtureOf(answering('done'));
    fixture.receiver.held = [];
    fixture.startDelivery();
    const sent = await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: webhook(fixture, { id: 'hook-1' }),
      },
    });
    const taskId = sent.result.task.id;
    await eventually(() => fixture.receiver.requests.length === 1);

    // Delete aborts the held attempt instead of waiting out the adapter's request timeout, which
    // is 10 s at the least: the test's own timeout is the bound.
    const deleted = await call(fixture, 'DeleteTaskPushNotificationConfig', {
      taskId,
      id: 'hook-1',
    });

    expect(deleted.error).toBeUndefined();
    const open = await fixture.outbox.list({ states: ['queued', 'claimed', 'attempting'] });
    expect(open).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.receiver.requests).toHaveLength(1);
  });

  it('answers UnsupportedOperationError for the extended Agent Card, which no deployment serves', async () => {
    const fixture = await fixtureOf(answering('done'));

    const reply = await call(fixture, 'GetExtendedAgentCard', {});

    expect(reply.error.code).toBe(-32004);
  });
});

describe('the push projection of a task a configuration outlives', () => {
  it('removes the checkpoint with its configuration', async () => {
    const fixture = await fixtureOf(answering('done'));
    const taskId = await startTask(fixture);
    await call(fixture, 'CreateTaskPushNotificationConfig', {
      taskId,
      id: 'hook-1',
      ...webhook(fixture),
    });
    const checkpoints = createA2APushCheckpoints(
      fixture.opened.bureau.kv as NonNullable<typeof fixture.opened.bureau.kv>,
    );
    expect(await checkpoints.read(taskId, 'hook-1')).toBeDefined();

    await call(fixture, 'DeleteTaskPushNotificationConfig', { taskId, id: 'hook-1' });

    expect(await checkpoints.read(taskId, 'hook-1')).toBeUndefined();
  });

  it('never leaves a configuration without its checkpoint when a create and a delete of one id race', async () => {
    const fixture = await fixtureOf(answering('done'));
    const taskId = await startTask(fixture);
    const checkpoints = createA2APushCheckpoints(
      fixture.opened.bureau.kv as NonNullable<typeof fixture.opened.bureau.kv>,
    );

    for (const id of ['race-1', 'race-2', 'race-3']) {
      await Promise.all([
        call(fixture, 'CreateTaskPushNotificationConfig', { taskId, ...webhook(fixture, { id }) }),
        call(fixture, 'DeleteTaskPushNotificationConfig', { taskId, id }),
      ]);
      const listed = await call(fixture, 'ListTaskPushNotificationConfigs', { taskId });
      const live = listed.result.configs.map((config: Json) => config.id);
      // The two orders both leave a consistent pair: the configuration and its checkpoint, or
      // neither.
      expect(live.includes(id)).toBe((await checkpoints.read(taskId, id)) !== undefined);
    }
  });

  it('leaves no settled delivery of a deleted configuration, and refuses the id again', async () => {
    const fixture = await fixtureOf(answering('done'));
    fixture.startDelivery();
    const sent = await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: webhook(fixture, { id: 'hook-1', token: 'token-a' }),
      },
    });
    const taskId = sent.result.task.id;
    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
    await eventually(async () => {
      const settled = await fixture.outbox.list({ states: ['acknowledged'] });
      return settled.length > 0;
    });

    await call(fixture, 'DeleteTaskPushNotificationConfig', { taskId, id: 'hook-1' });
    // The settled records carry the task's payload and the spent idempotency keys.
    expect(await fixture.outbox.list()).toEqual([]);

    // A deleted id stays a tombstone on its task: it is refused, never reused.
    const recreated = await call(fixture, 'CreateTaskPushNotificationConfig', {
      taskId,
      ...webhook(fixture, { id: 'hook-1', token: 'token-b' }),
    });
    expect(recreated.error).toBeDefined();
  });

  it('finishes an expired task whose install failed, and refuses another payload under its id', async () => {
    const fixture = await fixtureOf(answering('done'));
    const store = fixture.sender.pushStore as { create: (...input: never[]) => Promise<unknown> };
    const create = store.create.bind(store);
    store.create = async () => {
      store.create = create;
      throw new Error('the push store is down');
    };
    const send = (text: string) =>
      call(fixture, 'SendMessage', {
        message: {
          ...message(text),
          messageId: 'expired-1',
          metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' } },
        },
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: webhook(fixture, { id: 'hook-1' }),
        },
      });

    const failed = await send('too late');
    expect(failed.error).toBeDefined();

    // The task exists, so the claim stays: another payload under the same id is refused.
    const rebound = await send('something else');
    expect(rebound.error).toBeDefined();
    const retried = await send('too late');
    expect(retried.error).toBeUndefined();
    const listed = await call(fixture, 'ListTaskPushNotificationConfigs', {
      taskId: retried.result.task.id,
    });
    expect(listed.result.configs.map((config: Json) => config.id)).toEqual(['hook-1']);
  });
});
