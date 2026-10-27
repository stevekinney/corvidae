/**
 * COR-1713 — `CancelTask` answers with the task in its post-cancel state: it waits, bounded by
 * `cancelWaitMilliseconds`, for the run it canceled to stop, and answers a run still stopping
 * when the wait ends as it stands.
 */
import { Message, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, principalFromApiKey, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createCommandLedger } from '../command-ledger.ts';
import { waitForCondition } from '../test';
import { createBureauAgentCard } from './a2a-agent-card.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

/** A run that stops only on abort. */
const untilAborted: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/**
 * A handler over a Bureau whose runner parks until aborted. `stopping`, while it holds, makes the
 * handler read every task as still `working`: a run slow to stop, which a real run is not.
 */
async function open(options: { cancelWaitMilliseconds?: number; stopping?: () => boolean } = {}) {
  const opened = await openBureau({
    agents: { runner: createAgent({ name: 'runner', generate: untilAborted }) },
    publish: ['runner'],
  });
  const bureau = opened.bureau;
  const stopping = options.stopping ?? (() => false);
  const tasks: typeof bureau.internals.taskRegistry = {
    ...bureau.internals.taskRegistry,
    get: async (id) => {
      const view = await bureau.internals.taskRegistry.get(id);
      return view === undefined || !stopping() ? view : { ...view, status: 'working' };
    },
  };
  const served = new Proxy(bureau, {
    get: (target, key, receiver) =>
      key === 'internals'
        ? { ...target.internals, taskRegistry: tasks }
        : Reflect.get(target, key, receiver),
  });
  const runtime = createDefaultRuntimeServices();
  const host = buildBureauHandlerHost(bureau, ['runner']);
  const card = createBureauAgentCard({
    catalogName: 'runner',
    displayName: undefined,
    description: undefined,
    definitionRevision: 1,
    skillDescriptors: undefined,
    security: undefined,
    durableHistory: false,
    pushNotifications: false,
  });
  const handler = createBureauA2ARequestHandler({
    publicUrl: 'http://localhost',
    agentName: 'runner',
    card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
    bureau: served,
    records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
    ledger: createCommandLedger<A2ASendClaim, A2ASendResult>({
      kv: textValueStore(new MemoryStorage()),
      keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
      clock: runtime.clock,
      nextConflictId: () => runtime.identifiers.next('conflict'),
    }),
    respond: (principal, input) => respondToTask(host, principal, input),
    ...(options.cancelWaitMilliseconds === undefined
      ? {}
      : { cancelWaitMilliseconds: options.cancelWaitMilliseconds }),
  });
  const context = () =>
    new ServerCallContext({
      user: new BureauA2AUser(principalFromApiKey({ subject: 'alice', scopes: [] })),
      requestedVersion: '1.0',
    });
  const start = async (): Promise<string> => {
    const sent = await handler.sendMessage(
      {
        tenant: '',
        message: Message.fromJSON({ messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'go' }] }),
        configuration: { returnImmediately: true } as never,
        metadata: undefined,
      },
      context(),
    );
    if (!('status' in sent)) throw new Error('expected a task');
    await waitForCondition(
      () => bureau.tasks.detail(sent.id)?.status === 'running',
      'it never ran',
    );
    return sent.id;
  };
  const cancel = (id: string) =>
    handler.cancelTask({ tenant: '', id, metadata: undefined }, context());
  return { opened, bureau, start, cancel };
}

describe('CancelTask', () => {
  it('answers with the canceled task once a run that stops on abort has stopped', async () => {
    const fixture = await open();
    try {
      const id = await fixture.start();

      const canceled = await fixture.cancel(id);

      expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('answers a run still stopping when the wait ends with the task as it stands', async () => {
    let stopping = false;
    const fixture = await open({ cancelWaitMilliseconds: 20, stopping: () => stopping });
    try {
      const id = await fixture.start();
      stopping = true;

      const answered = await fixture.cancel(id);

      expect(answered.status?.state).toBe(TaskState.TASK_STATE_WORKING);
      const view = await fixture.bureau.internals.taskRegistry.get(id);
      expect(view?.status).toBe('canceled');
    } finally {
      await fixture.opened.dispose();
    }
  });
});
