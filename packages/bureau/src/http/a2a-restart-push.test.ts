/**
 * Push `Create` across a restart (COR-1669, part 2b-3a). The Bureau is stopped with a parked task
 * and a persisted push checkpoint and started again over the same storage and agent files, with
 * start-up recovery held, so a request arrives before recovery has reached the task:
 *
 * - `Create` waits for recovery before it takes the task's fence (recovery reconciles tasks under
 *   their fences, so the other order deadlocks);
 * - on a withdrawn agent's mount, a task that ends while `Create` waits is refused with nothing
 *   committed, and one that ends between the cursor and the commit has its terminal event
 *   delivered to the new webhook.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { A2A_PUSH_CHECKPOINT_KEY_PREFIX } from './a2a-push-checkpoint.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { authentication } from './management/management-fixtures.test-support.ts';
import { quietFor, yieldEventLoopTurn } from '@lostgradient/testing/wait-until';

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
  readonly call: (method: string, params: Json) => Promise<Json>;
  /** Settles when the call does. */
  readonly begin: (method: string, params: Json) => Promise<Json>;
  readonly stop: () => Promise<void>;
};

/** A latch the recovery's reads wait on until the test opens it. */
function latch(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

let counter = 0;
const message = (text: string, extra: Json = {}): Json => {
  counter += 1;
  return { messageId: `rp-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
};

/**
 * One world that outlives its Bureaus: the Bureau's SQLite file, the agent files, and the push
 * store and outbox storage are shared by every start.
 */
async function createWorld(
  options: {
    readonly held?: { readonly wait: Promise<void> };
    readonly onCreate?: () => Promise<void>;
  } = {},
) {
  const runtime = createDefaultRuntimeServices();
  const fixture = createSqliteStorageFixture({ runtime });
  const pushStorage = new MemoryStorage();
  const receiver = new Receiver();
  // The agent files outlive the first Bureau, which would remove a directory it made itself.
  const directory = await mkdtemp(join(tmpdir(), 'bureau-restart-push-'));
  const first = await startFileBureau({
    directory,
    overrides: {
      id: 'restart-push-bureau',
      models: { generate: () => parksOnRequest },
      storage: fixture.configuration,
    },
  });
  await first.put(
    'writer.md',
    agentFileText({ name: 'Writer', model: KNOWN_MODEL, published: 'true' }, 'Write.\n'),
  );
  await first.bureau.agents.refresh();
  cleanups.push(async () => {
    receiver.close();
    await rm(directory, { recursive: true, force: true });
    await fixture.dispose();
    pushStorage[Symbol.dispose]();
  });

  /** Serves a started Bureau, holding the push store's reads until `held` opens, if given. */
  function serve(
    harness: FileBureauHarness,
    held?: { readonly wait: Promise<void> },
    onCreate?: () => Promise<void>,
  ): Served {
    const store = createWeftPushNotificationStore({
      storage: pushStorage,
      namespace: 'bureau-push',
    });
    const pushStore: typeof store = {
      ...store,
      create: async (...parameters) => {
        await onCreate?.();
        return store.create(...parameters);
      },
    };
    // Recovery starts by listing the checkpoints; holding that holds it before any task's fence.
    const kv = harness.bureau.kv;
    if (held !== undefined && kv !== undefined) {
      const list = kv.list.bind(kv);
      kv.list = async (prefix, ...rest) => {
        if (prefix === A2A_PUSH_CHECKPOINT_KEY_PREFIX) await held.wait;
        return list(prefix, ...rest);
      };
    }
    const adapter = createHttpDeliveryAdapter({
      ...pushNotificationResolvers(store),
      signingSecrets: [SIGNING_SECRET],
      egressPolicy: createEgressPolicy({
        allowInsecureHttp: true,
        allowlist: [receiver.host],
        resolveHost: null,
      }),
    });
    const outbox = new Outbox({
      storage: pushStorage,
      namespace: 'bureau-push',
      ownerId: 'push',
      adapter,
    });
    const sender = createOutboxPushNotificationSender({ outbox, pushStore });
    const handler = createBureauHandler(harness.bureau, {
      authentication,
      publicUrl: 'http://localhost',
      pushNotifications: { sender, outbox },
    });
    const delivery = new AbortController();
    let stopped = false;
    void startPushDelivery({ outbox, signal: delivery.signal, intervalMs: 10 });
    const begin = async (method: string, params: Json): Promise<Json> => {
      const response = await handler(
        new Request('http://localhost/a2a/writer', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'A2A-Version': '1.0',
            'X-API-Key': 'alice-key',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      );
      return response.json();
    };
    return {
      harness,
      call: begin,
      begin,
      async stop() {
        if (stopped) return;
        stopped = true;
        delivery.abort();
        await harness.dispose();
        outbox.dispose();
      },
    };
  }

  const firstServed = serve(first, options.held, options.onCreate);
  cleanups.push(() => firstServed.stop());
  return {
    receiver,
    first: firstServed,
    /** Stops the running Bureau and starts another over the same files. */
    async restart(
      previous: Served,
      held?: { readonly wait: Promise<void> },
      onCreate?: () => Promise<void>,
    ): Promise<Served> {
      await previous.stop();
      const harness = await startFileBureau({
        directory: previous.harness.directory,
        overrides: {
          id: 'restart-push-bureau',
          models: { generate: () => parksOnRequest },
          storage: fixture.configuration,
        },
      });
      await harness.bureau.agents.refresh();
      const served = serve(harness, held, onCreate);
      cleanups.push(() => served.stop());
      return served;
    },
    async withdraw(served: Served): Promise<void> {
      const { bureau } = served.harness;
      const hash = bureau.agents.list().find((agent) => agent.id === 'writer')?.definitionHash;
      if (hash === undefined) throw new Error('expected the writer’s file');
      await bureau.agents.withdraw('writer', { expectedHash: hash });
      await bureau.agents.refresh();
    },
  };
}

const webhook = (receiver: Receiver, extra: Json = {}): Json => ({
  url: receiver.url(),
  token: 'token-1',
  authentication: { scheme: 'Bearer', credentials: 'credential-secret' },
  ...extra,
});

/** A parked task with one persisted push configuration (and so a checkpoint), then a restart. */
async function parkedAcrossRestart(
  options: { readonly withdraw?: boolean; readonly onCreate?: () => Promise<void> } = {},
) {
  const world = await createWorld();
  const sent = await world.first.call('SendMessage', { message: message('park here') });
  expect(sent.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  const taskId: string = sent.result.task.id;
  const created = await world.first.call('CreateTaskPushNotificationConfig', {
    taskId,
    id: 'before',
    ...webhook(world.receiver),
  });
  expect(created.error).toBeUndefined();
  if (options.withdraw === true) await world.withdraw(world.first);
  const held = latch();
  const served = await world.restart(world.first, held, options.onCreate);
  return { world, served, held, taskId };
}

describe('push Create before start-up recovery has reached the task', () => {
  it('completes once recovery does, rather than deadlocking with it', async () => {
    const { world, served, held, taskId } = await parkedAcrossRestart();

    const pending = served.begin('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'after',
      ...webhook(world.receiver),
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // Recovery is held on its first read of the push store, and Create waits behind it.
    await quietFor(100);
    expect(settled).toBe(false);

    held.open();
    const created = await pending;
    expect(created.error).toBeUndefined();
    expect(created.result.id).toBe('after');
    const listed = await served.call('ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs.map((config: Json) => config.id)).toEqual(['before', 'after']);
  });
});

/** A live parked task on a withdrawn agent's mount, with a Bureau whose recovery is held. */
async function parkedWithdrawn(options: { readonly onCreate?: () => Promise<void> } = {}) {
  const held = latch();
  const world = await createWorld({ held, ...options });
  const sent = await world.first.call('SendMessage', { message: message('park here') });
  expect(sent.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  const taskId: string = sent.result.task.id;
  await world.withdraw(world.first);
  return { world, served: world.first, held, taskId };
}

async function cancelAndAwait(served: Served, taskId: string): Promise<void> {
  const canceled = await served.call('CancelTask', { id: taskId });
  expect(canceled.error).toBeUndefined();
  await eventually(async () => {
    const task = await served.call('GetTask', { id: taskId });
    return task.result.status.state === 'TASK_STATE_CANCELED';
  });
}

describe('a task that ends around a Create on a withdrawn agent’s mount', () => {
  it('refuses Create, committing nothing, when the task ends before the cursor is read', async () => {
    const { world, served, held, taskId } = await parkedWithdrawn();

    // The request is admitted (the task is live) and waits behind start-up recovery.
    const pending = served.begin('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'late',
      ...webhook(world.receiver),
    });
    // The request is admitted within a few turns of this process, however busy the host is.
    for (let turn = 0; turn < 3; turn += 1) await yieldEventLoopTurn();
    await cancelAndAwait(served, taskId);
    held.open();

    const created = await pending;
    expect(created.error.code).toBe(-32004);
    const listed = await served.call('ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs ?? []).toEqual([]);
    // Nothing durable either: a refused Create leaves no checkpoint, pending or confirmed.
    const checkpoints = await served.harness.bureau.kv?.list(A2A_PUSH_CHECKPOINT_KEY_PREFIX);
    expect(checkpoints ?? []).toEqual([]);
    expect(world.receiver.requests).toEqual([]);
  });

  it('delivers the terminal event to the new webhook when the task ends after the cursor', async () => {
    let reached: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const commit = latch();
    const { world, served, held, taskId } = await parkedWithdrawn({
      onCreate: async () => {
        reached();
        await commit.wait;
      },
    });
    held.open();

    const pending = served.begin('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'racing',
      ...webhook(world.receiver),
    });
    // The cursor is read and the task is still live; the configuration is not yet committed.
    await arrived;
    await cancelAndAwait(served, taskId);
    commit.open();

    const created = await pending;
    expect(created.error).toBeUndefined();
    await eventually(() => world.receiver.kinds().includes('status:TASK_STATE_CANCELED'));
  });
});
